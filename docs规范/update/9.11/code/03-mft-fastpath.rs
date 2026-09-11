// -----------------------------------------------------------------------------
// 落地位置：D:\KaiFa\Trim\native-scanner\src\main.rs（新增模块，建议单独文件 mft.rs）
// 作用：NTFS $MFT 直读快路径 —— 顺序读盘枚举全卷文件（含大小），秒级完成
// 依赖：无新增 crate（全部 FFI 直调 kernel32）
//
// ★ 先纠正一个常见误解：USN 日志（FSCTL_ENUM_USN_DATA）里【没有文件大小】。
//   USN_RECORD 只有文件名、父/自身引用号、时间戳与属性。
//   所以「找大文件」不能只靠 USN：要么读 $MFT（本文件做法），
//   要么拿 USN 的路径后再 stat（退化成普通递归，没有意义）。
//
// ★ 前提与风险（务必读完再启用）：
//   1) 需要管理员权限（CreateFileW 打开 \\.\C: 需要）。Trim 的
//      requestedExecutionLevel 现在是 asInvoker，正确做法是运行时探测：
//      能打开就用 MFT，打不开就静默回退到 01/02 的 Win32 递归。
//   2) 只支持 NTFS。FAT32/exFAT/ReFS/网络盘必须回退。
//   3) $MFT 不与内存中的文件系统状态完全一致（正在写入的文件可能大小滞后），
//      所以 MFT 结果只用于「展示与排序」，真正删除前必须用 fs::metadata 复核一次。
//   4) 本骨架未处理：属性列表（$ATTRIBUTE_LIST，超大/碎片文件的跨记录属性）、
//      硬链接多父（同一记录号多个 $FILE_NAME）、压缩/稀疏文件的占盘口径差异。
//      这三项都要在生产化时补齐，否则会出现「漏文件」或「重复计数」。
// -----------------------------------------------------------------------------

#![allow(dead_code)]
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::path::PathBuf;

// ---- FFI ------------------------------------------------------------------
#[link(name = "kernel32")]
extern "system" {
    fn CreateFileW(
        lp: *const u16, access: u32, share: u32, sa: *const u8,
        disp: u32, flags: u32, tmpl: *const u8,
    ) -> *mut core::ffi::c_void;
    fn DeviceIoControl(
        h: *mut core::ffi::c_void, code: u32, inb: *const u8, inlen: u32,
        outb: *mut u8, outlen: u32, ret: *mut u32, ov: *const u8,
    ) -> i32;
    fn SetFilePointerEx(h: *mut core::ffi::c_void, dist: i64, newpos: *mut i64, method: u32) -> i32;
    fn ReadFile(h: *mut core::ffi::c_void, buf: *mut u8, n: u32, got: *mut u32, ov: *const u8) -> i32;
    fn CloseHandle(h: *mut core::ffi::c_void) -> i32;
}

const FSCTL_GET_NTFS_VOLUME_DATA: u32 = 0x00090064;
const GENERIC_READ: u32 = 0x80000000;
const FILE_SHARE_READ: u32 = 1;
const FILE_SHARE_WRITE: u32 = 2;
const OPEN_EXISTING: u32 = 3;
const INVALID_HANDLE: *mut core::ffi::c_void = !0 as _;

#[repr(C)]
#[derive(Default)]
struct NtfsVolumeData {
    serial: i64, sectors: i64, total_clusters: i64, free_clusters: i64, reserved: i64,
    bytes_per_sector: u32,
    bytes_per_cluster: u32,
    bytes_per_file_record: u32,
    clusters_per_file_record: u32,
    mft_valid: i64,
    mft_start_lcn: i64,
    mft2_start_lcn: i64,
    mft_zone_start: i64,
    mft_zone_end: i64,
}

fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 返回 Some((句柄, MFT 起始字节偏移, 单条记录字节数, 扇区字节数))。
/// 无权限 / 非 NTFS 时返回 None —— 调用方据此回退到 Win32 递归。
fn open_mft(volume: char) -> Option<(*mut core::ffi::c_void, i64, u32, u32)> {
    let path = utf16(&format!("\\\\.\\{}:", volume));
    unsafe {
        let h = CreateFileW(
            path.as_ptr(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(), OPEN_EXISTING, 0, std::ptr::null(),
        );
        if h == INVALID_HANDLE {
            return None;
        }
        let mut vd = NtfsVolumeData::default();
        let mut got: u32 = 0;
        let ok = DeviceIoControl(
            h, FSCTL_GET_NTFS_VOLUME_DATA, std::ptr::null(), 0,
            &mut vd as *mut _ as *mut u8,
            std::mem::size_of::<NtfsVolumeData>() as u32, &mut got, std::ptr::null(),
        );
        if ok == 0 {
            CloseHandle(h);
            return None;
        }
        let bps = vd.bytes_per_sector;
        let rec = if vd.bytes_per_file_record > 0 {
            vd.bytes_per_file_record
        } else {
            (vd.clusters_per_file_record.max(1)) * vd.bytes_per_cluster
        };
        if bps == 0 || rec == 0 {
            CloseHandle(h);
            return None;
        }
        let off = vd.mft_start_lcn * (vd.bytes_per_cluster as i64);
        Some((h, off, rec, bps))
    }
}

/// 应用更新序列数组（USA）修正。NTFS 在每个扇区末尾写入保护值，
/// 不修正的话读出来的是"错 2 字节"的记录 —— 这是自研 MFT 解析最常见的坑。
fn apply_fixup(rec: &mut [u8], sector: usize) -> bool {
    if rec.len() < 0x30 {
        return false;
    }
    let usa_off = u16::from_le_bytes([rec[4], rec[5]]) as usize;
    let usa_cnt = u16::from_le_bytes([rec[6], rec[7]]) as usize;
    if usa_cnt < 2 || usa_off + usa_cnt * 2 > rec.len() {
        return false;
    }
    let usn = u16::from_le_bytes([rec[usa_off], rec[usa_off + 1]]);
    for i in 1..usa_cnt {
        let pos = i * sector - 2;
        if pos + 2 > rec.len() {
            break;
        }
        let cur = u16::from_le_bytes([rec[pos], rec[pos + 1]]);
        if cur != usn {
            return false; // 坏记录：整条跳过
        }
        let fix = u16::from_le_bytes([rec[usa_off + i * 2], rec[usa_off + i * 2 + 1]]);
        rec[pos] = (fix & 0xff) as u8;
        rec[pos + 1] = (fix >> 8) as u8;
    }
    true
}

struct Entry {
    parent: u64,
    name: String,
    size: u64,
    is_dir: bool,
}

/// 解析单条 FILE 记录，返回 (记录号, Entry)。
fn parse_record(buf: &[u8], sector: usize) -> Option<(u64, Entry)> {
    let mut rec = buf.to_vec();
    if &rec[0..4] != b"FILE" {
        return None; // 含 "BAAD" 坏记录
    }
    if !apply_fixup(&mut rec, sector) {
        return None;
    }
    let attrs_off = u16::from_le_bytes([rec[0x14], rec[0x15]]) as usize;
    let flags = u16::from_le_bytes([rec[0x16], rec[0x17]]);
    let is_dir = (flags & 0x02) != 0; // FILE_RECORD_IS_DIRECTORY
    let rec_num = u32::from_le_bytes([rec[0x2C], rec[0x2D], rec[0x2E], rec[0x2F]]) as u64;

    let mut p = attrs_off;
    let mut best: Option<Entry> = None;
    while p + 8 <= rec.len() {
        let ty = u32::from_le_bytes([rec[p], rec[p + 1], rec[p + 2], rec[p + 3]]);
        if ty == 0xFFFFFFFF {
            break;
        }
        let len = u32::from_le_bytes([rec[p + 4], rec[p + 5], rec[p + 6], rec[p + 7]]) as usize;
        if len == 0 || p + len > rec.len() {
            break;
        }
        if ty == 0x30 {
            // $FILE_NAME
            let nonres = rec[p + 8];
            if nonres == 0 {
                let voff = u16::from_le_bytes([rec[p + 0x14], rec[p + 0x15]]) as usize;
                let v = p + voff;
                if v + 0x42 <= rec.len() {
                    let parent = u64::from_le_bytes(rec[v..v + 8].try_into().unwrap()) & 0x0000FFFFFFFFFFFF;
                    let size = u64::from_le_bytes(rec[v + 0x30..v + 0x38].try_into().unwrap());
                    let attr = u32::from_le_bytes(rec[v + 0x38..v + 0x3C].try_into().unwrap());
                    let nlen = rec[v + 0x40] as usize;
                    let ns = rec[v + 0x41];
                    let name: Vec<u16> = (0..nlen)
                        .map(|i| u16::from_le_bytes([rec[v + 0x42 + i * 2], rec[v + 0x43 + i * 2]]))
                        .collect();
                    // 命名空间：0=POSIX 1=Win32 2=DOS(8.3) 3=Win32&DOS；只取 0/1 避免 8.3 重名
                    if (ns == 0 || ns == 1) && !name.is_empty() {
                        let is_dir_attr = (attr & 0x10) != 0;
                        best = Some(Entry {
                            parent,
                            name: String::from_utf16_lossy(&name),
                            size,
                            is_dir: is_dir_attr || is_dir,
                        });
                    }
                }
            }
        }
        p += len;
    }
    best.map(|e| (rec_num, e))
}

/// 读整个 $MFT，返回 Top-N 大文件（绝对路径）。
/// count：需要的条数；roots 只用来决定卷（如 "C:\\"）。
pub fn bigfiles_via_mft(volume: char, count: usize) -> Option<Vec<(u64, PathBuf)>> {
    let (h, mft_off, rec_size, sector) = open_mft(volume)?;
    let rec_size = rec_size as usize;
    let sector = sector as usize;

    // 一次读 8 MB，顺序扫（比逐条 FSCTL_READ_MFT_RECORD 快两个数量级）
    let chunk = 8 * 1024 * 1024;
    let per_chunk = (chunk / rec_size).max(1);
    let mut buf = vec![0u8; per_chunk * rec_size];

    let mut recs: HashMap<u64, Entry> = HashMap::new();
    let mut idx: u64 = 0;
    let mut heap: BinaryHeap<Reverse<(u64, u64)>> = BinaryHeap::new(); // (size, rec_no)

    unsafe {
        let mut cur = mft_off;
        loop {
            let mut moved: i64 = 0;
            if SetFilePointerEx(h, cur, &mut moved, 0) == 0 {
                break;
            }
            let mut got: u32 = 0;
            if ReadFile(h, buf.as_mut_ptr(), buf.len() as u32, &mut got, std::ptr::null()) == 0 {
                break;
            }
            if got == 0 {
                break;
            }
            let n = (got as usize) / rec_size;
            for i in 0..n {
                let slice = &buf[i * rec_size..(i + 1) * rec_size];
                if let Some((no, e)) = parse_record(slice, sector) {
                    if !e.is_dir {
                        if heap.len() < count {
                            heap.push(Reverse((e.size, no)));
                        } else if let Some(&Reverse((smallest, _))) = heap.peek() {
                            if e.size > smallest {
                                heap.pop();
                                heap.push(Reverse((e.size, no)));
                            }
                        }
                    }
                    recs.insert(no, e);
                }
                idx += 1;
            }
            cur += (n * rec_size) as i64;
            let _ = idx;
        }
        CloseHandle(h);
    }

    // 用 parent 链还原路径（根目录记录号固定为 5）
    fn build_path(recs: &HashMap<u64, Entry>, no: u64) -> PathBuf {
        let mut parts: Vec<String> = Vec::new();
        let mut cur = no;
        for _ in 0..64 {
            match recs.get(&cur) {
                Some(e) => {
                    parts.push(e.name.clone());
                    if cur == 5 || e.parent == cur {
                        break;
                    }
                    cur = e.parent;
                }
                None => break,
            }
        }
        parts.reverse();
        let mut p = PathBuf::from(format!("{}:\\", 'C'));
        for s in parts {
            p.push(s);
        }
        p
    }

    let mut out: Vec<(u64, PathBuf)> = heap
        .into_iter()
        .map(|Reverse((sz, no))| (sz, build_path(&recs, no)))
        .collect();
    out.sort_by(|a, b| b.0.cmp(&a.0));
    Some(out)
}

/// 调用示例（放在 cmd_bigfiles 入口最前面）：
///
///   if let Some(root_drive) = roots.first().and_then(|r| r.chars().next()) {
///       if let Some(top) = bigfiles_via_mft(root_drive, count) {
///           for (i, (sz, p)) in top.iter().enumerate() {
///               item("bigfile", p, *sz, &[("rank", (i + 1).to_string()),
///                                          ("source", "mft".into())]);
///           }
///           progress(100);
///           return;
///       }
///   }
///   // 无权限/非 NTFS → 走 02 的 Win32 递归
///   cmd_bigfiles_fast(roots, count);
