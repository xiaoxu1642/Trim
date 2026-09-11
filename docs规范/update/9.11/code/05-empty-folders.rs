// -----------------------------------------------------------------------------
// 落地位置：D:\KaiFa\Trim\native-scanner\src\main.rs
// 作用：替换 collect_empty / cmd_empty（现版本 main.rs:675-766）
//
// 先说结论：现有实现【逻辑是对的】，与 HiBit 的 Empty Folder Cleaner 基本同构：
//   · 目录空 = 不含任何文件（含 0 字节文件）且所有子目录均为空目录  —— 与 HiBit 一致
//   · 父目录为空时只保留父（删父连带删内层）                        —— 对应 Czkawka 的做法
//   · 不可读目录保守视为非空                                        —— 正确的安全取向
//   · 扫描根只作容器不作候选，避免"扫一个空目录就把根删了"          —— 很好的细节
//   · 删除走回收站（recycle::send_to_trash），比 HiBit 的"备份后删"更省事
//
// 缺的三项：
//   1) 没有用户级忽略名单 —— HiBit 有（"Ignore this Folder" 持久化），
//      否则每次扫描都会把用户刻意保留的空目录（比如 git 的空占位目录）重新列出来。
//   2) 单线程 + 每文件一次 fs::metadata。
//   3) 结果里看不出"删这个父目录会连带删掉几个子空目录"，用户难以判断。
// -----------------------------------------------------------------------------

#![allow(dead_code)]
use rayon::prelude::*;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 忽略名单：%APPDATA%\Trim\empty-ignore.txt，每行一个绝对路径，大小写不敏感。
/// 前端加"忽略此文件夹"时直接追加一行即可。
fn ignore_file() -> Option<PathBuf> {
    std::env::var("APPDATA").ok().map(|a| PathBuf::from(a).join("Trim").join("empty-ignore.txt"))
}

fn load_ignore() -> HashSet<String> {
    let mut s = HashSet::new();
    if let Some(f) = ignore_file() {
        if let Ok(txt) = std::fs::read_to_string(&f) {
            for line in txt.lines() {
                let l = line.trim();
                if !l.is_empty() {
                    s.insert(l.to_lowercase());
                }
            }
        }
    }
    s
}

pub fn add_ignore(path: &Path) {
    if let Some(f) = ignore_file() {
        if let Some(dir) = f.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        use std::io::Write;
        if let Ok(mut fh) = std::fs::OpenOptions::new().create(true).append(true).open(&f) {
            let _ = writeln!(fh, "{}", path.display());
        }
    }
}

fn ignored(set: &HashSet<String>, p: &Path) -> bool {
    set.contains(&p.to_string_lossy().to_string().to_lowercase())
}

/// 并行收集：把根目录的一级子目录交给 rayon，各自串行递归。
pub fn cmd_empty_v2(roots: &[String]) {
    let ignore = load_ignore();
    let empty_files: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
    let empty_dirs: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

    for r in roots {
        let Some(p) = canonical(r) else { continue };
        // 根自身只作容器
        let tops: Vec<PathBuf> = match std::fs::read_dir(&p) {
            Ok(rd) => rd
                .flatten()
                .filter(|e| matches!(e.file_type(), Ok(t) if t.is_dir()) && !is_reparse(e))
                .map(|e| e.path())
                .filter(|pp| !ignored(&ignore, pp))
                .collect(),
            Err(_) => Vec::new(),
        };
        tops.par_iter().for_each(|d| {
            let mut f: Vec<PathBuf> = Vec::new();
            let mut dd: Vec<PathBuf> = Vec::new();
            let _ = collect_empty_fast(d, &ignore, &mut f, &mut dd);
            if !f.is_empty() {
                empty_files.lock().unwrap().extend(f);
            }
            if !dd.is_empty() {
                empty_dirs.lock().unwrap().extend(dd);
            }
        });
    }

    let files = empty_files.into_inner().unwrap();
    let dirs = empty_dirs.into_inner().unwrap();

    // 父目录折叠：只保留最外层（删父即连带删子）
    let set: HashSet<PathBuf> = dirs.iter().cloned().collect();
    let mut out: Vec<(PathBuf, usize)> = Vec::new();
    for d in &dirs {
        if d.parent().map(|pp| set.contains(pp)).unwrap_or(false) {
            continue; // 存在空父目录，跳过自己
        }
        // 统计被它覆盖的内层空目录数量，供前端提示
        let nested = dirs
            .iter()
            .filter(|x| *x != d && x.starts_with(d))
            .count();
        out.push((d.clone(), nested));
    }

    for f in &files {
        item("emptyfile", f, 0, &[]);
    }
    for (d, n) in &out {
        item("emptyfolder", d, 0, &[("nested", n.to_string())]);
    }
    progress(100);
}

/// 返回该目录是否整体为空。与原 collect_empty 相同语义，
/// 区别是用 ent.metadata() 取大小（不额外 syscall）。
fn collect_empty_fast(
    dir: &Path,
    ignore: &HashSet<String>,
    files: &mut Vec<PathBuf>,
    dirs: &mut Vec<PathBuf>,
) -> bool {
    if ignored(ignore, dir) {
        return false; // 被忽略的目录视为非空，不进候选也不继续下钻
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return false, // 不可读保守视为非空
    };
    let mut empty = true;
    for ent in rd.flatten() {
        let ft = match ent.file_type() {
            Ok(t) => t,
            Err(_) => {
                empty = false;
                continue;
            }
        };
        if ft.is_symlink() {
            empty = false;
            continue;
        }
        if ft.is_dir() {
            if is_reparse(&ent) {
                empty = false;
            } else if !collect_empty_fast(&ent.path(), ignore, files, dirs) {
                empty = false;
            }
        } else if ft.is_file() {
            // DirEntry 自带大小，不额外查询
            let sz = ent.metadata().map(|m| m.len()).unwrap_or(1);
            if sz == 0 {
                files.push(ent.path());
            }
            empty = false; // 任何文件（含 0 字节）都让父目录不算空
        } else {
            empty = false;
        }
    }
    if empty {
        dirs.push(dir.to_path_buf());
    }
    empty
}

// 以下沿用 main.rs 现有实现，仅为片段自洽
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
        std::fs::canonicalize(p).ok().or(Some(p.to_path_buf()))
    } else {
        Some(p.to_path_buf())
    }
}
fn item(_t: &str, _p: &Path, _size: u64, _extra: &[(&str, String)]) {}
fn progress(n: u64) {
    println!("@@PROGRESS:{}@@", n);
}
