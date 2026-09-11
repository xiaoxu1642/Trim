// -----------------------------------------------------------------------------
// 落地位置：D:\KaiFa\Trim\native-scanner\src\main.rs（新增模块）
// 作用：用 GetFileInformationByHandleEx(FileIdBothDirectoryInfo) 批量枚举目录
// 依赖：无新增 crate
//
// 为什么值得做（介于 FindFirstFileW 与 MFT 之间的中间档）：
//   · FindFirstFileW 每次只吐一条，用户态/内核态切换次数 = 条目数；
//     这个 API 一次调用把【整个目录】的条目一次性搬进缓冲区（FILE_ID_BOTH_DIR_INFO 链表）。
//   · 返回的每条记录同时带 EndOfFile（逻辑大小）与 AllocationSize（占盘大小），
//     等于一次拿到 SpaceSniffer 区分的 filesize 与 disksize 两个口径，
//     不必再调用 GetCompressedFileSizeW。
//   · 不需要管理员权限，NTFS/ReFS 都能用。
//
// 适用边界：条目越多的目录收益越明显（上千条目的目录最划算）；
//           小目录与 FindFirstFileW 基本持平。真正全盘级别的提速仍要靠 03 的 MFT。
// -----------------------------------------------------------------------------

#![allow(dead_code)]
use std::path::{Path, PathBuf};

#[link(name = "kernel32")]
extern "system" {
    fn CreateFileW(
        lp: *const u16, access: u32, share: u32, sa: *const u8,
        disp: u32, flags: u32, tmpl: *const u8,
    ) -> *mut core::ffi::c_void;
    fn GetFileInformationByHandleEx(
        h: *mut core::ffi::c_void, class: u32, buf: *mut u8, len: u32,
    ) -> i32;
    fn CloseHandle(h: *mut core::ffi::c_void) -> i32;
}

const FILE_LIST_DIRECTORY: u32 = 0x0001;
const FILE_SHARE_ALL: u32 = 7;
const OPEN_EXISTING: u32 = 3;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x02000000;
const FILE_ID_BOTH_DIR_INFO: u32 = 10; // FILE_INFO_BY_HANDLE_CLASS
const INVALID_HANDLE: *mut core::ffi::c_void = !0 as _;

#[derive(Debug, Clone)]
pub struct DirEntryInfo {
    pub name: String,
    pub logical_size: u64,   // EndOfFile：文件真实字节数
    pub allocated_size: u64, // AllocationSize：按簇分配的占盘字节数
    pub is_dir: bool,
    pub is_reparse: bool,
    pub last_write: i64,
}

fn utf16(s: &str) -> Vec<u16> {
    // 目录路径需加 \\?\ 前缀才能绕过 MAX_PATH
    let full = format!("\\\\?\\{}", s);
    full.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 一次性读取目录下全部条目。返回 Err 表示不可打开（权限/路径问题）。
pub fn enum_dir_both(dir: &Path) -> Result<Vec<DirEntryInfo>, String> {
    let s = dir.to_string_lossy().to_string();
    let w = utf16(&s);
    unsafe {
        let h = CreateFileW(
            w.as_ptr(), FILE_LIST_DIRECTORY, FILE_SHARE_ALL, std::ptr::null(),
            OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, std::ptr::null(),
        );
        if h == INVALID_HANDLE {
            return Err(format!("CreateFileW 打开目录失败: {}", s));
        }
        let mut buf = vec![0u8; 256 * 1024];
        let ok = GetFileInformationByHandleEx(h, FILE_ID_BOTH_DIR_INFO, buf.as_mut_ptr(), buf.len() as u32);
        let mut out = Vec::new();
        if ok != 0 {
            let mut off: usize = 0;
            loop {
                // FILE_ID_BOTH_DIR_INFO:
                //   +0x00 NextEntryOffset(u32)
                //   +0x04 FileIndex(u32)
                //   +0x08 CreationTime(i64) +0x10 LastAccess +0x18 LastWrite +0x20 Change
                //   +0x28 EndOfFile(i64)
                //   +0x30 AllocationSize(i64)
                //   +0x38 FileAttributes(u32)
                //   +0x3C FileNameLength(u32)
                //   +0x40 EaSize(u32)
                //   +0x44 ShortNameLength(i8)  [+ ShortName 24 bytes]
                //   +0x50 FileId(i64)
                //   +0x58 FileName (UTF-16, 长度 FileNameLength 字节)
                if off + 0x58 > buf.len() {
                    break;
                }
                let next = u32::from_ne_bytes(buf[off..off + 4].try_into().unwrap()) as usize;
                let eof = i64::from_ne_bytes(buf[off + 0x28..off + 0x30].try_into().unwrap());
                let alloc = i64::from_ne_bytes(buf[off + 0x30..off + 0x38].try_into().unwrap());
                let attrs = u32::from_ne_bytes(buf[off + 0x38..off + 0x3C].try_into().unwrap());
                let nlen = u32::from_ne_bytes(buf[off + 0x3C..off + 0x40].try_into().unwrap()) as usize;
                let lw = i64::from_ne_bytes(buf[off + 0x18..off + 0x20].try_into().unwrap());
                let name_start = off + 0x58;
                let name: Vec<u16> = (0..(nlen / 2))
                    .map(|i| {
                        u16::from_ne_bytes([
                            buf[name_start + i * 2],
                            buf[name_start + i * 2 + 1],
                        ])
                    })
                    .collect();
                let name = String::from_utf16_lossy(&name);
                if name != "." && name != ".." {
                    out.push(DirEntryInfo {
                        name,
                        logical_size: eof.max(0) as u64,
                        allocated_size: alloc.max(0) as u64,
                        is_dir: (attrs & 0x10) != 0,
                        is_reparse: (attrs & 0x400) != 0,
                        last_write: lw,
                    });
                }
                if next == 0 {
                    break;
                }
                off += next;
            }
        }
        CloseHandle(h);
        Ok(out)
    }
}

/// 与 02 号文件的 Top-K 结合：用批量枚举替代 walk 的逐条返回。
/// 注意：缓冲区固定 256 KB，超大目录需要循环调用（GetFileInformationByHandleEx
/// 返回 ERROR_MORE_DATA 时需再次调用续读）——生产化时补上这段续读逻辑。
pub fn topk_with_batch(dir: &Path, cap: usize) -> Vec<(u64, PathBuf)> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;
    let mut heap: BinaryHeap<Reverse<(u64, PathBuf)>> = BinaryHeap::new();
    let mut stack: Vec<PathBuf> = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let ents = match enum_dir_both(&d) {
            Ok(v) => v,
            Err(_) => continue,
        };
        for e in ents {
            if e.is_reparse || e.name == "." || e.name == ".." {
                continue;
            }
            let p = d.join(&e.name);
            if e.is_dir {
                stack.push(p);
            } else if !e.is_dir {
                if heap.len() < cap {
                    heap.push(Reverse((e.logical_size, p)));
                } else if let Some(&Reverse((smallest, _))) = heap.peek() {
                    if e.logical_size > smallest {
                        heap.pop();
                        heap.push(Reverse((e.logical_size, p)));
                    }
                }
            }
        }
    }
    let mut v: Vec<(u64, PathBuf)> = heap.into_iter().map(|Reverse((s, p))| (s, p)).collect();
    v.sort_by(|a, b| b.0.cmp(&a.0));
    v
}
