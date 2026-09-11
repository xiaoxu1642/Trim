// 文件：TrimFastSize.cs（随应用打包的扫描加速辅助 DLL）
// 编译：scripts/build-fastsize.ps1（先删后编，否则 Add-Type -OutputAssembly 可能不覆盖旧 DLL）
// 用法：Add-Type -Path TrimFastSize.dll; [TrimFastSize]::Sum('C:\path')
// 原理：.NET 6+ 的 FileSystemEnumerable<T> 走 FindFirstFileW，WIN32_FIND_DATA 自带
//       文件大小，投影成 long 全程不构造 FileInfo 对象、不进 PowerShell 管道，
//       实测 npm-cache（56866 文件）枚举 906-1070 ms，比 Get-ChildItem 快 5.3x。
// 口径：与 cleanup-scripts.js 的 Get-FileKeySnapshot 一致——跳 ReparsePoint、忽略无权限。
using System;
using System.IO;
using System.IO.Enumeration;

public static class TrimFastSize
{
    // 传进来的若是文件（而非目录），直接返回其长度，避免 FileSystemEnumerable 抛异常
    internal static bool TryFileLength(string path, out long len)
    {
        len = 0;
        try
        {
            var fi = new FileInfo(path);
            if (fi.Exists)
            {
                // 存在但无权读取长度时按 0 处理，与现有 Get-PathSize 的 catch 语义一致
                try { len = fi.Length; } catch { len = 0; }
                return true;
            }
        }
        catch { }
        return false;
    }

    // 与 Get-FileKeySnapshot（cleanup-scripts.js:258）口径一致：跳 ReparsePoint、忽略无权限
    static EnumerationOptions Opts()
    {
        return new EnumerationOptions
        {
            RecurseSubdirectories = true,
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.ReparsePoint
        };
    }

    // 目录项不参与统计：FindFirstFile 对目录的 size 字段恒为 0，累加无影响，
    // 但 SumCount 的计数会把目录算进去（npm-cache 71977 含 13111 个目录 → 56866 文件），
    // 与 PowerShell Get-ChildItem -File 的「只数文件」语义不一致，故显式排除。
    static bool Skip(FileSystemEntry e, bool all, string pattern)
    {
        return e.IsDirectory || (!all && !FileSystemName.MatchesSimpleExpression(pattern, e.FileName, true));
    }

    // 整目录累加：FindFirstFile 枚举时直接带出 Length，无需每文件再 stat
    public static long Sum(string root)
    {
        if (TryFileLength(root, out long f)) return f;
        long total = 0;
        try
        {
            foreach (var len in new FileSystemEnumerable<long>(root,
                (ref FileSystemEntry e) => e.IsDirectory ? 0L : e.Length, Opts())) total += len;
        }
        catch { }   // 路径不存在/不可访问 → 按 0 处理，与现有 Get-PathSize 的 catch 语义一致
        return total;
    }

    // 带文件名通配过滤（fileKeys 的 pattern 语义，大小写不敏感）
    public static long SumMatch(string root, string pattern)
    {
        bool all = string.IsNullOrEmpty(pattern) || pattern == "*";
        if (all && TryFileLength(root, out long f)) return f;
        long total = 0;
        try
        {
            foreach (var len in new FileSystemEnumerable<long>(root,
                (ref FileSystemEntry e) => Skip(e, all, pattern) ? 0L : e.Length, Opts())) total += len;
        }
        catch { }
        return total;
    }

    // 同时返回总大小与文件数（供扫描条目一次拿全）；-1L 为"未命中过滤/目录项"哨兵
    public static long[] SumCount(string root, string pattern)
    {
        bool all = string.IsNullOrEmpty(pattern) || pattern == "*";
        if (all && TryFileLength(root, out long fl)) return new long[] { fl, 1 };
        long total = 0, n = 0;
        try
        {
            foreach (var len in new FileSystemEnumerable<long>(root,
                (ref FileSystemEntry e) => Skip(e, all, pattern) ? -1L : e.Length, Opts()))
            {
                if (len < 0) continue;
                total += len; n++;
            }
        }
        catch { }
        return new long[] { total, n };
    }

    // ==================== 可删性探测（v2.2 第 3 批 / D7） ====================
    // 单文件可删性探针：以独占方式打开（FileShare.None，拒绝一切共享）。
    // 任一进程持该文件句柄（无论其共享模式是否允许读）→ 打开失败 → 判为不可删。
    // 近似 FluentCleaner 的 CreateFileW(DELETE) 预检：PS 侧分析文档认可
    // `[IO.File]::Open($p,'Open','Read','None')` 为可用近似。语义为保守——
    // 「正被读取但允许删除」的文件也会被剔除（宁可少报，不可虚报可释放量）。
    static bool Deletable(string path)
    {
        try
        {
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None)) { }
            return true;
        }
        catch { return false; }
    }

    // 公开给 PowerShell 侧消费的可删文件条目（public 字段，Add-Type 后可直接 .Path/.Size）
    public sealed class FastFileInfo
    {
        public string Path;
        public long Size;
    }

    public sealed class DeletableResult
    {
        public FastFileInfo[] Files;   // 可删文件（探测通过）
        public long TotalCount;        // 枚举到的全部文件数（被占用数 = TotalCount - Files.Length）
    }

    // 单遍枚举 + 探测：与 SumCount 同口径（跳 ReparsePoint、忽略无权限、文件名 pattern 匹配），
    // 但每个文件多做一次独占打开探测，剔除正被占用的文件——扫描值即「真实可删值」，
    // 根治「显示 8GB、清理完只释放 300MB」的虚报（D7）。FindFirstFile 枚举直接带出
    // Length 与 FullPath，全程不构造 FileInfo 对象，探测外的开销只多一次 Open/Close。
    public static DeletableResult ListDeletable(string root, string pattern)
    {
        bool all = string.IsNullOrEmpty(pattern) || pattern == "*";
        if (all && TryFileLength(root, out long fl))
        {
            if (Deletable(root))
                return new DeletableResult { Files = new FastFileInfo[] { new FastFileInfo { Path = root, Size = fl } }, TotalCount = 1 };
            return new DeletableResult { Files = new FastFileInfo[0], TotalCount = 1 };
        }
        var files = new System.Collections.Generic.List<FastFileInfo>();
        long total = 0;
        try
        {
            foreach (var fi in new FileSystemEnumerable<FastFileInfo>(root,
                (ref FileSystemEntry e) =>
                {
                    if (Skip(e, all, pattern)) return null;   // 目录/未命中过滤 → 跳过
                    total++;                                  // 闭包计数：全部文件（含被占用）
                    string full = e.ToFullPath();
                    if (Deletable(full)) return new FastFileInfo { Path = full, Size = e.Length };
                    return null;
                }, Opts()))
            {
                if (fi != null) files.Add(fi);
            }
        }
        catch { }   // 路径不存在/不可访问 → 空结果，与 SumCount 的 catch 语义一致
        return new DeletableResult { Files = files.ToArray(), TotalCount = total };
    }
}
