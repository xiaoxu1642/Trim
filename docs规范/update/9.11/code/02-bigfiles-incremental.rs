// -----------------------------------------------------------------------------
// 落地位置：D:\KaiFa\Trim\native-scanner\src\main.rs
// 作用：替换现有 cmd_bigfiles()（现版本 main.rs:648-673）
// 依赖：rayon（已有）
//
// 现版本的三个问题：
//   a) 先 walk 全量收进 Vec<(PathBuf,u64)> 再取 Top-N —— 百万级文件时这个 Vec
//      就是几十上百 MB 的常驻内存，而最终只有 50 条要输出。
//   b) walk 单线程。
//   c) 全程无进度，只在最后 progress(100)。
//
// 改法：任务分片 + 每片本地 Top-K 堆 + reduce 归并。
//   内存：O(线程数 × N) 而不是 O(文件总数)
//   并发：rayon 按目录分片，天然无锁（不需要 Mutex<Vec>）
//   进度：每 8192 个文件输出一次 @@SCANNED:n@@ 心跳
// -----------------------------------------------------------------------------

use rayon::prelude::*;
use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// 任务展开深度：把根目录下的子目录铺开成并行任务。
/// 太浅 → 任务粒度粗（比如整个 C:\Windows 一个任务）；太深 → 任务数爆炸。
const TASK_DEPTH: usize = 2;
/// 单个任务内累计多少文件输出一次心跳。
const HEARTBEAT_EVERY: u64 = 8192;

type Heap = BinaryHeap<Reverse<(u64, PathBuf)>>;

/// 把根目录展开成并行任务列表（深度 ≤ TASK_DEPTH 的子目录）。
/// 根目录直属文件也作为一个任务（用根目录自身表示，任务内只收文件不递归）。
fn expand_tasks(root: &Path) -> Vec<(PathBuf, bool)> {
    // (目录, 是否递归)
    let mut out: Vec<(PathBuf, bool)> = vec![(root.to_path_buf(), false)];
    let mut level: Vec<PathBuf> = vec![root.to_path_buf()];
    for _ in 0..TASK_DEPTH {
        let mut next: Vec<PathBuf> = Vec::new();
        for d in &level {
            let rd = match std::fs::read_dir(d) {
                Ok(r) => r,
                Err(_) => continue,
            };
            for ent in rd.flatten() {
                if let Ok(ft) = ent.file_type() {
                    if ft.is_dir() && !is_reparse(&ent) {
                        let p = ent.path();
                        out.push((p.clone(), true));
                        next.push(p);
                    }
                }
            }
        }
        level = next;
        if level.is_empty() {
            break;
        }
    }
    out
}

/// 在一个任务内串行递归，只保留最大的 cap 个。
fn topk_in(dir: &Path, recursive: bool, cap: usize, counter: &AtomicU64) -> Heap {
    let mut heap: Heap = BinaryHeap::new();
    let mut stack: Vec<(PathBuf, bool)> = vec![(dir.to_path_buf(), recursive)];
    let mut local: u64 = 0;

    while let Some((d, rec)) = stack.pop() {
        let rd = match std::fs::read_dir(&d) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for ent in rd.flatten() {
            let ft = match ent.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                if rec && !is_reparse(&ent) {
                    stack.push((ent.path(), true));
                }
            } else if ft.is_file() {
                // DirEntry 自带大小，不额外 syscall
                if let Ok(md) = ent.metadata() {
                    let sz = md.len();
                    push_topk(&mut heap, sz, ent.path(), cap);
                    local += 1;
                    if local % HEARTBEAT_EVERY == 0 {
                        counter.fetch_add(local, Ordering::Relaxed);
                        println!("@@SCANNED:{}@@", counter.load(Ordering::Relaxed));
                        local = 0;
                    }
                }
            }
        }
    }
    counter.fetch_add(local, Ordering::Relaxed);
    heap
}

#[inline]
fn push_topk(heap: &mut Heap, sz: u64, path: PathBuf, cap: usize) {
    if heap.len() < cap {
        heap.push(Reverse((sz, path)));
        return;
    }
    // 堆顶是当前保留集合里最小的那个（Reverse 最小堆）
    if let Some(top) = heap.peek() {
        if sz > top.0 .0 {
            heap.pop();
            heap.push(Reverse((sz, path)));
        }
    }
}

fn merge_into(a: &mut Heap, b: Heap, cap: usize) {
    for Reverse((sz, p)) in b {
        push_topk(a, sz, p, cap);
    }
}

/// 新版 bigfiles：任务并行 + 分片 Top-K + 心跳。输出协议与旧版完全一致。
pub fn cmd_bigfiles_fast(roots: &[String], count: usize) {
    // 依赖 01 号文件里的初始化
    crate::init_scan_threads();

    let counter = AtomicU64::new(0);
    let cap = count.max(1);

    let mut tasks: Vec<(PathBuf, bool)> = Vec::new();
    for r in roots {
        if let Some(p) = canonical(r) {
            tasks.extend(expand_tasks(&p));
        }
    }
    if tasks.is_empty() {
        return;
    }

    let heap: Heap = tasks
        .par_iter()
        .map(|(d, rec)| topk_in(d, *rec, cap, &counter))
        .reduce(|| BinaryHeap::new(), |mut a, b| {
            merge_into(&mut a, b, cap);
            a
        });

    let mut all: Vec<(u64, PathBuf)> = heap
        .into_iter()
        .map(|Reverse((sz, p))| (sz, p))
        .collect();
    all.sort_by(|a, b| b.0.cmp(&a.0));

    for (i, (sz, p)) in all.iter().enumerate() {
        item("bigfile", p, *sz, &[("rank", (i + 1).to_string())]);
    }
    println!("@@SCANNED:{}@@", counter.load(Ordering::Relaxed));
    progress(100);
}

// ---------------------------------------------------------------------------
// 可选：HiBit 式「规则目录优先」——先出结果再补全量。
// 用法：cmd_bigfiles 入口加 --quick 时先跑这一段，把前 N 条 emit 出去（rank 前缀 quick），
// 前端立刻有内容可显示，随后跑 cmd_bigfiles_fast 输出完整结果覆盖。
// ---------------------------------------------------------------------------
pub fn bigfiles_quick(count: usize) -> Vec<(u64, PathBuf)> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for key in ["USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "SystemDrive"] {
        if let Ok(v) = std::env::var(key) {
            let base = PathBuf::from(v);
            for sub in ["Downloads", "Desktop", "Documents", "Videos", "Pictures"] {
                let p = base.join(sub);
                if p.is_dir() {
                    dirs.push(p);
                }
            }
            if key != "SystemDrive" {
                dirs.push(base);
            }
        }
    }
    let counter = AtomicU64::new(0);
    let cap = count.max(1);
    let heap: Heap = dirs
        .par_iter()
        .map(|d| topk_in(d, true, cap, &counter))
        .reduce(|| BinaryHeap::new(), |mut a, b| {
            merge_into(&mut a, b, cap);
            a
        });
    let mut all: Vec<(u64, PathBuf)> = heap.into_iter().map(|Reverse((sz, p))| (sz, p)).collect();
    all.sort_by(|a, b| b.0.cmp(&a.0));
    all
}

// 以下沿用 main.rs 现有实现，仅为片段自洽而声明
#[cfg(windows)]
fn is_reparse(ent: &std::fs::DirEntry) -> bool {
    use std::os::windows::fs::MetadataExt;
    ent.metadata()
        .map(|m| (m.file_attributes() & 0x400) != 0)
        .unwrap_or(false)
}
#[cfg(not(windows))]
fn is_reparse(_ent: &std::fs::DirEntry) -> bool {
    false
}
fn canonical(s: &str) -> Option<PathBuf> {
    let p = Path::new(s);
    if p.exists() {
        let c = std::fs::canonicalize(p).ok();
        c.or(Some(p.to_path_buf()))
    } else {
        Some(p.to_path_buf())
    }
}
fn item(_t: &str, _p: &Path, _size: u64, _extra: &[(&str, String)]) {}
fn progress(n: u64) {
    println!("@@PROGRESS:{}@@", n);
}
