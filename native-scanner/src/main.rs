// Trim 内建原生扫描器。
// 以行为单位输出：@@ITEM@@{json} 与 @@PROGRESS:n@@，供 Electron 主进程流式解析。
// 重复文件三级检测：内容指纹（体积+Blake3）> 文档内容相似（shingle/Jaccard）> 同名文件，
// 每个文件最多归入一组；扫描与删除均在 Rust 中完成。
use rayon::prelude::*;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

fn eprint_err(e: &std::io::Error, what: &str) {
    eprintln!("[finder-warn] {}: {}", what, e);
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn unix_path(p: &Path) -> String {
    let mut s = p.to_string_lossy().to_string();
    if s.starts_with(r"\\?\") {
        s = s[4..].to_string();
    }
    s.replace('\\', "/")
}

fn item(t: &str, path: &Path, size: u64, extra: &[(&str, String)]) {
    let mut s = String::from("@@ITEM@@{\"type\":\"");
    s.push_str(t);
    s.push_str("\",\"path\":\"");
    s.push_str(&json_escape(&unix_path(path)));
    s.push_str("\",\"size\":");
    s.push_str(&size.to_string());
    for (k, v) in extra {
        s.push_str(",\"");
        s.push_str(k);
        s.push_str("\":\"");
        s.push_str(&json_escape(v));
        s.push_str("\"");
    }
    s.push_str("}\n");
    use std::io::Write;
    let _ = std::io::stdout().write_all(s.as_bytes());
}

fn progress(n: u64) {
    println!("@@PROGRESS:{}@@", n.min(100));
}

/// 审查v4-M6：是否重解析点（junction/挂载点）。Windows 目录联接点不是 symlink
/// （file_type().is_symlink()==false），须按 FILE_ATTRIBUTE_REPARSE_POINT (0x400) 判定；
/// 否则自引用联接点（如「Application Data」历史环）会逐层加深重复遍历，扫描卡到超时。
#[cfg(windows)]
fn is_reparse(ent: &fs::DirEntry) -> bool {
    use std::os::windows::fs::MetadataExt;
    ent.metadata()
        .map(|m| (m.file_attributes() & 0x400) != 0)
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_reparse(_ent: &fs::DirEntry) -> bool {
    false
}

/// 递归收集文件（跳过符号链接、重解析点与不可读目录）。
/// 审查v4-L5：移除从未使用的 dirs 参数（原收集目录后 let _ = dirs 丢弃，白耗内存）。
fn walk(path: &Path, files: &mut Vec<(PathBuf, u64)>, min_size: u64) {
    let mut stack: Vec<PathBuf> = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(e) => {
                eprint_err(&e, &format!("read_dir {}", dir.display()));
                continue;
            }
        };
        for ent in rd.flatten() {
            let fp = ent.path();
            let ft = match ent.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                // 审查v4-M6：联接点/挂载点不深入
                if is_reparse(&ent) {
                    continue;
                }
                stack.push(fp);
            } else if ft.is_file() {
                let sz = fs::metadata(&fp).map(|m| m.len()).unwrap_or(0);
                if sz >= min_size {
                    files.push((fp, sz));
                }
            }
        }
    }
}

/// 快速返回某个顶层目录下的一级子目录大小（用于 AppData 迁移挑选）。
fn child_dir_sizes(root: &Path, out: &mut Vec<(PathBuf, u64)>) {
    let rd = match fs::read_dir(root) {
        Ok(r) => r,
        Err(_) => return,
    };
    // 审查v4-M6：只统计真实目录——Path::is_dir 会跟随联接点/符号链接，
    // 指向其他卷的联接点会把扫描范围外的内容重复计入
    let children: Vec<PathBuf> = rd
        .flatten()
        .filter(|ent| match ent.file_type() {
            Ok(t) => t.is_dir() && !is_reparse(ent),
            Err(_) => false,
        })
        .map(|ent| ent.path())
        .collect();
    let sizes: Vec<(PathBuf, u64)> = children
        .par_iter()
        .map(|path| (path.clone(), dir_size(path)))
        .filter(|(_, size)| *size >= 1)
        .collect();
    out.extend(sizes);
}

fn dir_size(dir: &Path) -> u64 {
    let mut total: u64 = 0;
    let mut stack: Vec<PathBuf> = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let rd = match fs::read_dir(&d) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for ent in rd.flatten() {
            let fp = ent.path();
            match ent.file_type() {
                Ok(t) if t.is_symlink() => continue,
                // 审查v4-M6：联接点/挂载点不深入（同 walk）
                Ok(t) if t.is_dir() && !is_reparse(&ent) => stack.push(fp),
                Ok(t) if t.is_file() => {
                    if let Ok(md) = fs::metadata(&fp) {
                        total += md.len();
                    }
                }
                _ => {}
            }
        }
    }
    total
}

/// 计算完整文件的 Blake3 内容指纹；先按体积分组，只有可能重复的文件才会进入这里。
fn file_fp(path: &Path) -> Option<[u8; 32]> {
    let mut f = fs::File::open(path).ok()?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 256 * 1024];
    use std::io::Read;
    loop {
        match f.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => { hasher.update(&buf[..n]); }
            Err(_) => return None,
        }
    }
    Some(*hasher.finalize().as_bytes())
}

/// 重复文件三级检测：内容指纹（体积+Blake3）> 文档内容相似 > 同名文件。
/// 每个文件最多归入一组；组 id 前缀 dupc/dups/dupn，match 字段供前端区分展示。
fn cmd_duplicates(roots: &[String], min_size: u64) {
    let mut files: Vec<(PathBuf, u64)> = Vec::new();
    for r in roots {
        if let Some(p) = canonical(r) {
            // 目录不存在时 walk 内部仅告警跳过，不影响其余目录
            walk(&p, &mut files, 0);
        }
    }
    let total = files.len() as f64;
    let mut empty: Vec<PathBuf> = Vec::new();
    for (i, f) in files.iter().enumerate() {
        if f.1 == 0 {
            empty.push(f.0.clone());
        }
        if i % 2000 == 0 {
            progress((i as f64 / total.max(1.0) * 15.0) as u64);
        }
    }
    progress(15);
    // ---------- 1) 内容指纹组：仅同体积文件计算 Blake3 ----------
    let hashed: Vec<(u64, PathBuf, [u8; 32])> = files
        .par_iter()
        .filter(|(_, sz)| *sz > 0 && *sz >= min_size)
        .filter_map(|(p, sz)| file_fp(p).map(|fp| (*sz, p.clone(), fp)))
        .collect();
    progress(60);
    let mut cmap: HashMap<(u64, [u8; 32]), Vec<PathBuf>> = HashMap::new();
    for (size, path, fp) in hashed {
        cmap.entry((size, fp)).or_default().push(path);
    }
    let mut content_groups: Vec<(u64, Vec<PathBuf>)> = cmap
        .into_iter()
        .filter(|(_, v)| v.len() >= 2)
        .map(|(k, v)| (k.0, v))
        .collect();
    content_groups.sort_by_key(|(sz, _)| std::cmp::Reverse(*sz));
    let mut taken: HashSet<PathBuf> = HashSet::new();
    for (_, v) in &content_groups {
        for p in v {
            taken.insert(p.clone());
        }
    }
    // ---------- 2) 文档内容相似组 ----------
    let similar_groups = find_similar_doc_groups(&files, &taken);
    for (_, v) in &similar_groups {
        for (p, _) in v {
            taken.insert(p.clone());
        }
    }
    progress(85);
    // ---------- 3) 同名文件组（含扩展名一致，忽略大小写） ----------
    let mut nmap: HashMap<String, Vec<(PathBuf, u64)>> = HashMap::new();
    for (p, sz) in &files {
        if *sz == 0 || taken.contains(p) {
            continue; // 0 字节文件已作为 emptyfile 输出，不再参与同名分组
        }
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        nmap.entry(name).or_default().push((p.clone(), *sz));
    }
    let mut name_groups: Vec<(u64, Vec<(PathBuf, u64)>)> = nmap
        .into_values()
        .filter(|v| v.len() >= 2)
        .map(|v| {
            let sum: u64 = v.iter().map(|(_, s)| s).sum();
            (sum, v)
        })
        .collect();
    name_groups.sort_by_key(|(sum, _)| std::cmp::Reverse(*sum));
    progress(95);
    // ---------- 输出 ----------
    let mut gid = 0usize;
    for (sz, v) in &content_groups {
        gid += 1;
        emit_dup_group(
            &v.iter().map(|p| (p.clone(), *sz)).collect::<Vec<_>>(),
            &format!("dupc{:04}", gid),
            "content",
            None,
        );
    }
    for (sim, v) in &similar_groups {
        gid += 1;
        emit_dup_group(v, &format!("dups{:04}", gid), "similar", Some(*sim));
    }
    for (_, v) in &name_groups {
        gid += 1;
        emit_dup_group(v, &format!("dupn{:04}", gid), "name", None);
    }
    for e in empty {
        item("emptyfile", &e, 0, &[]);
    }
    progress(100);
}

fn emit_dup_group(v: &[(PathBuf, u64)], gid: &str, match_kind: &str, sim: Option<u64>) {
    for (idx, (p, sz)) in v.iter().enumerate() {
        let mut extra: Vec<(&str, String)> = vec![
            ("group", gid.to_string()),
            ("role", if idx == 0 { "kept".to_string() } else { "candidate".to_string() }),
            ("match", match_kind.to_string()),
        ];
        if let Some(s) = sim {
            extra.push(("sim", format!("{}%", s)));
        }
        item("duplicate", p, *sz, &extra);
    }
}

// ==================== 文档内容相似检测 ====================
const SIM_EXTS: [&str; 5] = ["txt", "md", "log", "csv", "docx"];
const SIM_MIN_BYTES: u64 = 256; // 过短文本 shingle 太少，不参与相似判定
const SIM_MAX_BYTES: u64 = 4 * 1024 * 1024;
const SIM_MIN_SHINGLES: usize = 24;
const SIM_THRESHOLD: f64 = 0.8;
const SIM_MAX_DOCS: usize = 2000; // 单扩展名参与上限，防极端目录拖垮扫描
const SIM_MAX_PAIRS: usize = 400_000; // 单扩展名两两比较上限

fn dsu_find(parent: &mut [usize], mut x: usize) -> usize {
    while parent[x] != x {
        parent[x] = parent[parent[x]];
        x = parent[x];
    }
    x
}

/// 归一化：小写、丢弃非字母数字、空白折叠为单空格。
fn normalize_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending_space = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if ch.is_alphanumeric() {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            for lc in ch.to_lowercase() {
                out.push(lc);
            }
        } else {
            pending_space = false;
        }
    }
    out
}

/// 16 字符窗口 shingle + FNV-1a 哈希，1/3 采样降内存；返回排序去重的指纹集。
fn shingle_set(norm: &str) -> Option<Vec<u64>> {
    const W: usize = 16;
    const STRIDE: usize = 3;
    let chars: Vec<char> = norm.chars().collect();
    if chars.len() < W * 6 {
        return None;
    }
    let mut raw: Vec<u64> = Vec::with_capacity(chars.len() / STRIDE + 1);
    let mut i = 0usize;
    while i + W <= chars.len() {
        let mut h: u64 = 0xcbf29ce484222325;
        for ch in &chars[i..i + W] {
            let c = *ch as u32;
            h = (h ^ (c as u64)).wrapping_mul(0x100000001b3);
            h = (h ^ ((c >> 16) as u64)).wrapping_mul(0x100000001b3);
        }
        raw.push(h);
        i += STRIDE;
    }
    raw.sort_unstable();
    raw.dedup();
    if raw.len() < SIM_MIN_SHINGLES {
        return None;
    }
    Some(raw)
}

fn jaccard(a: &[u64], b: &[u64]) -> f64 {
    let (mut i, mut j) = (0usize, 0usize);
    let mut inter = 0usize;
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                inter += 1;
                i += 1;
                j += 1;
            }
        }
    }
    let uni = a.len() + b.len() - inter;
    if uni == 0 {
        0.0
    } else {
        inter as f64 / uni as f64
    }
}

fn doc_sketch(path: &Path) -> Option<Vec<u64>> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let text = if ext == "docx" {
        extract_docx_text(path)?
    } else {
        let raw = fs::read(path).ok()?;
        String::from_utf8_lossy(&raw).into_owned()
    };
    shingle_set(&normalize_text(&text))
}

/// 文档相似检测：Jaccard ≥ 阈值的文档经并查集聚类；返回 (簇内最低相似度%, 成员)。
fn find_similar_doc_groups(
    files: &[(PathBuf, u64)],
    taken: &HashSet<PathBuf>,
) -> Vec<(u64, Vec<(PathBuf, u64)>)> {
    let mut buckets: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, (p, sz)) in files.iter().enumerate() {
        if *sz < SIM_MIN_BYTES || *sz > SIM_MAX_BYTES || taken.contains(p) {
            continue;
        }
        let ext = p
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if SIM_EXTS.contains(&ext.as_str()) {
            buckets.entry(ext).or_default().push(i);
        }
    }
    let mut out: Vec<(u64, Vec<(PathBuf, u64)>)> = Vec::new();
    for (ext, mut idxs) in buckets {
        if idxs.len() > SIM_MAX_DOCS {
            eprintln!(
                "[finder-warn] .{} 文档 {} 个超出相似检测上限，仅分析前 {} 个",
                ext,
                idxs.len(),
                SIM_MAX_DOCS
            );
            idxs.truncate(SIM_MAX_DOCS);
        }
        let sketches: Vec<Option<Vec<u64>>> =
            idxs.par_iter().map(|i| doc_sketch(&files[*i].0)).collect();
        // (sketches 下标, 指纹长度)，按长度升序便于窗口剪枝：Jaccard ≤ 短集/长集
        let mut docs: Vec<(usize, usize)> = sketches
            .iter()
            .enumerate()
            .filter(|(_, s)| s.as_ref().map(|v| v.len()).unwrap_or(0) >= SIM_MIN_SHINGLES)
            .map(|(k, s)| (k, s.as_ref().map(|v| v.len()).unwrap_or(0)))
            .collect();
        docs.sort_by_key(|(_, l)| *l);
        let n = docs.len();
        if n < 2 {
            continue;
        }
        let mut parent: Vec<usize> = (0..n).collect();
        let mut min_edge: Vec<u64> = vec![100u64; n];
        let mut pairs = 0usize;
        let mut capped = false;
        for i in 0..n {
            let (ki, li) = docs[i];
            let si = sketches[ki].as_ref().unwrap();
            for j in i + 1..n {
                let (kj, lj) = docs[j];
                if (lj as f64) * SIM_THRESHOLD > li as f64 {
                    break; // 长度差过大，不可能达到阈值
                }
                pairs += 1;
                if pairs > SIM_MAX_PAIRS {
                    capped = true;
                    break;
                }
                let jac = jaccard(si, sketches[kj].as_ref().unwrap());
                if jac >= SIM_THRESHOLD {
                    let pct = (jac * 100.0).round().min(100.0) as u64;
                    let ri = dsu_find(&mut parent, i);
                    let rj = dsu_find(&mut parent, j);
                    if ri != rj {
                        parent[rj] = ri;
                        min_edge[ri] = min_edge[ri].min(min_edge[rj]).min(pct);
                    }
                }
            }
            if capped {
                eprintln!("[finder-warn] .{} 相似比较次数达上限，部分文档未参与聚类", ext);
                break;
            }
        }
        let mut clusters: HashMap<usize, Vec<usize>> = HashMap::new();
        for i in 0..n {
            let r = dsu_find(&mut parent, i);
            clusters.entry(r).or_default().push(i);
        }
        let mut groups: Vec<(u64, Vec<(PathBuf, u64)>)> = clusters
            .into_values()
            .filter(|m| m.len() >= 2)
            .map(|m| {
                let root = dsu_find(&mut parent, m[0]);
                let sim = min_edge[root];
                let members: Vec<(PathBuf, u64)> = m
                    .iter()
                    .map(|k| {
                        let fi = idxs[docs[*k].0];
                        (files[fi].0.clone(), files[fi].1)
                    })
                    .collect();
                (sim, members)
            })
            .collect();
        groups.sort_by_key(|(_, v)| {
            let max: u64 = v.iter().map(|(_, s)| *s).max().unwrap_or(0);
            std::cmp::Reverse(max)
        });
        out.extend(groups);
    }
    out
}

// ==================== docx 正文抽取 ====================
/// 解压 docx（zip 容器）中的 word/document.xml 并转纯文本。
fn extract_docx_text(path: &Path) -> Option<String> {
    let data = fs::read(path).ok()?;
    if data.len() > (SIM_MAX_BYTES as usize) * 2 {
        return None;
    }
    let xml = zip_read_entry(&data, b"word/document.xml")?;
    Some(xml_to_text(&xml))
}

/// 在 zip 字节流中按中央目录查找并解压单个条目（支持 stored 与 raw deflate）。
fn zip_read_entry(data: &[u8], want: &[u8]) -> Option<Vec<u8>> {
    const EOCD_SIG: [u8; 4] = [0x50, 0x4b, 0x05, 0x06];
    const CDH_SIG: [u8; 4] = [0x50, 0x4b, 0x01, 0x02];
    const LFH_SIG: [u8; 4] = [0x50, 0x4b, 0x03, 0x04];
    if data.len() < 22 {
        return None;
    }
    // 从尾部找 EOCD（zip 注释最长 65535 字节）
    let scan_start = data.len().saturating_sub(22 + 65535);
    let mut eocd = None;
    let mut i = data.len() - 22;
    loop {
        if data[i..i + 4] == EOCD_SIG {
            eocd = Some(i);
            break;
        }
        if i == scan_start {
            break;
        }
        i -= 1;
    }
    let eocd = eocd?;
    let entries = u16::from_le_bytes([data[eocd + 10], data[eocd + 11]]) as usize;
    let cd_off = u32::from_le_bytes([
        data[eocd + 16],
        data[eocd + 17],
        data[eocd + 18],
        data[eocd + 19],
    ]) as usize;
    let mut p = cd_off;
    for _ in 0..entries {
        if p + 46 > data.len() || data[p..p + 4] != CDH_SIG {
            return None;
        }
        let method = u16::from_le_bytes([data[p + 10], data[p + 11]]);
        let csize =
            u32::from_le_bytes([data[p + 20], data[p + 21], data[p + 22], data[p + 23]]) as usize;
        let name_len = u16::from_le_bytes([data[p + 28], data[p + 29]]) as usize;
        let extra_len = u16::from_le_bytes([data[p + 30], data[p + 31]]) as usize;
        let comment_len = u16::from_le_bytes([data[p + 32], data[p + 33]]) as usize;
        let lfh_off = u32::from_le_bytes([
            data[p + 42],
            data[p + 43],
            data[p + 44],
            data[p + 45],
        ]) as usize;
        let name = &data[p + 46..p + 46 + name_len];
        p += 46 + name_len + extra_len + comment_len;
        if name.eq_ignore_ascii_case(want) {
            if lfh_off + 30 > data.len() || data[lfh_off..lfh_off + 4] != LFH_SIG {
                return None;
            }
            let l_name = u16::from_le_bytes([data[lfh_off + 26], data[lfh_off + 27]]) as usize;
            let l_extra = u16::from_le_bytes([data[lfh_off + 28], data[lfh_off + 29]]) as usize;
            let start = lfh_off + 30 + l_name + l_extra;
            let comp = data.get(start..start + csize)?;
            return match method {
                0 => Some(comp.to_vec()),
                8 => miniz_oxide::inflate::decompress_to_vec(comp).ok(),
                _ => None,
            };
        }
    }
    None
}

/// document.xml 转纯文本：段落尾换行、去标签、解常见实体。
fn xml_to_text(xml: &[u8]) -> String {
    let s = String::from_utf8_lossy(xml);
    let mut out = String::with_capacity(s.len() / 2);
    let mut in_tag = false;
    let mut tag = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' => {
                if tag.starts_with("/w:p") || tag.starts_with("/w:br") || tag == "w:br" {
                    out.push('\n');
                } else if tag.starts_with("w:tab") {
                    out.push(' ');
                }
                in_tag = false;
            }
            _ => {
                if in_tag {
                    tag.push(c);
                } else if c == '&' {
                    let mut ent = String::new();
                    for e in chars.by_ref() {
                        if e == ';' {
                            break;
                        }
                        ent.push(e);
                        if ent.len() > 10 {
                            break;
                        }
                    }
                    match ent.as_str() {
                        "amp" => out.push('&'),
                        "lt" => out.push('<'),
                        "gt" => out.push('>'),
                        "quot" => out.push('"'),
                        "apos" => out.push('\''),
                        _ => {
                            let cp = ent.strip_prefix('#').and_then(|num| {
                                num.strip_prefix('x')
                                    .or_else(|| num.strip_prefix('X'))
                                    .and_then(|h| u32::from_str_radix(h, 16).ok())
                                    .or_else(|| num.parse::<u32>().ok())
                            });
                            if let Some(ch) = cp.and_then(char::from_u32) {
                                out.push(ch);
                            }
                        }
                    }
                } else {
                    out.push(c);
                }
            }
        }
    }
    out
}

fn cmd_bigfiles(roots: &[String], count: usize) {
    let mut files: Vec<(PathBuf, u64)> = Vec::new();
    for r in roots {
        if let Some(p) = canonical(r) {
            walk(&p, &mut files, 0);
        }
    }
    // 用堆取 Top-N
    let mut heap: BinaryHeap<(std::cmp::Reverse<u64>, PathBuf)> = BinaryHeap::new();
    for (p, sz) in files {
        if heap.len() < count {
            heap.push((std::cmp::Reverse(sz), p));
        } else if let Some(&(std::cmp::Reverse(smallest), _)) = heap.peek() {
            if sz > smallest {
                heap.pop();
                heap.push((std::cmp::Reverse(sz), p));
            }
        }
    }
    let mut all: Vec<(u64, PathBuf)> = heap.into_iter().map(|(r, p)| (r.0, p)).collect();
    all.sort_by(|a, b| b.0.cmp(&a.0));
    for (i, (sz, p)) in all.iter().enumerate() {
        item("bigfile", p, *sz, &[("rank", (i + 1).to_string())]);
    }
    progress(100);
}

fn cmd_empty(roots: &[String]) {
    let mut empty_files: Vec<PathBuf> = Vec::new();
    let mut empty_dirs: Vec<PathBuf> = Vec::new();
    for r in roots {
        if let Some(p) = canonical(r) {
            // 扫描根目录只作为容器，不作为删除候选，避免“扫描一个空目录”时误删根目录。
            let _ = collect_empty_children(&p, &mut empty_files, &mut empty_dirs);
        }
    }
    // 借鉴 Czkawka optimize_folders：若某空目录的父目录同样为空目录，只保留父（删父连带删内层）
    use std::collections::HashSet;
    let set: HashSet<PathBuf> = empty_dirs.iter().cloned().collect();
    let mut top: Vec<PathBuf> = Vec::new();
    for d in &empty_dirs {
        let nested = d.parent().map(|pp| set.contains(pp)).unwrap_or(false);
        if !nested {
            top.push(d.clone());
        }
    }
    for f in &empty_files {
        item("emptyfile", f, 0, &[]);
    }
    for d in &top {
        item("emptyfolder", d, 0, &[]);
    }
    progress(100);
}

fn collect_empty_children(dir: &Path, files: &mut Vec<PathBuf>, dirs: &mut Vec<PathBuf>) -> bool {
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return false,
    };
    let mut empty = true;
    for ent in rd.flatten() {
        let fp = ent.path();
        match ent.file_type() {
            Ok(t) if t.is_symlink() => empty = false,
            Ok(t) if t.is_dir() => {
                if !collect_empty(&fp, files, dirs) {
                    empty = false;
                }
            }
            Ok(t) if t.is_file() => {
                let sz = fs::metadata(&fp).map(|m| m.len()).unwrap_or(1);
                if sz == 0 {
                    files.push(fp);
                }
                empty = false;
            }
            _ => empty = false,
        }
    }
    empty
}

/// 递归收集空文件与空目录；返回该目录是否整体为空（可删除）。
/// 空：不含任何文件（含 0 字节文件），且所有子目录均为空目录（借鉴 Czkawka empty_folder）。
fn collect_empty(dir: &Path, files: &mut Vec<PathBuf>, dirs: &mut Vec<PathBuf>) -> bool {
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return false, // 不可读目录保守视为非空
    };
    let mut empty = true;
    for ent in rd.flatten() {
        let fp = ent.path();
        match ent.file_type() {
            Ok(t) if t.is_symlink() => {
                empty = false;
            }
            Ok(t) if t.is_dir() => {
                if !collect_empty(&fp, files, dirs) {
                    empty = false;
                }
            }
            Ok(t) if t.is_file() => {
                let sz = fs::metadata(&fp).map(|m| m.len()).unwrap_or(1);
                if sz == 0 {
                    files.push(fp); // 空文件单独作为删除候选
                }
                empty = false; // 任何文件（含空文件）都使其父目录不算空文件夹
            }
            _ => {
                empty = false;
            }
        }
    }
    if empty {
        dirs.push(dir.to_path_buf());
    }
    empty
}

fn cmd_appdata(min_size_mb: u64) {
    let minb = min_size_mb * 1024 * 1024;
    let mut roots: Vec<(String, PathBuf)> = Vec::new();
    if let Ok(l) = std::env::var("LOCALAPPDATA") {
        roots.push(("Local".to_string(), PathBuf::from(l)));
    }
    if let Ok(r) = std::env::var("APPDATA") {
        roots.push(("Roaming".to_string(), PathBuf::from(r)));
    }
    let mut out: Vec<(String, PathBuf, u64)> = Vec::new();
    for (label, root) in roots {
        let mut cur: Vec<(PathBuf, u64)> = Vec::new();
        child_dir_sizes(&root, &mut cur);
        for (p, sz) in cur {
            if sz >= minb {
                out.push((label.clone(), p, sz));
            }
        }
    }
    out.sort_by(|a, b| b.2.cmp(&a.2));
    for (label, p, sz) in out {
        item("appdata", &p, sz, &[("root", label)]);
    }
    progress(100);
}

/// 计算一批路径的总大小（用于磁盘清理扫描核心 Rust 化）。路径已由调用方解析为绝对路径。
fn cmd_sizes(paths: &[String]) {
    let mut total_files = 0usize;
    let mut total_dirs = 0usize;
    for rp in paths {
        let p = Path::new(rp);
        if !p.exists() {
            item("size", p, 0, &[("exists", "false".to_string())]);
            continue;
        }
        if p.is_file() {
            let sz = fs::metadata(p).map(|m| m.len()).unwrap_or(0);
            total_files += 1;
            item("size", p, sz, &[("exists", "true".to_string())]);
        } else if p.is_dir() {
            let sz = dir_size(p);
            total_dirs += 1;
            item("size", p, sz, &[("exists", "true".to_string())]);
        }
    }
    let _ = (total_files, total_dirs);
    progress(100);
}

// 回收站删除：SHFileOperationW + FOF_ALLOWUNDO（shell32）。
// 手工声明 extern 绑定与结构体，避免为单一 API 引入 windows/winapi 依赖。
#[cfg(windows)]
mod recycle {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    const FO_DELETE: u32 = 3;
    const FOF_SILENT: u16 = 0x0004;
    const FOF_NOCONFIRMATION: u16 = 0x0010;
    const FOF_ALLOWUNDO: u16 = 0x0040;
    const FOF_NOERRORUI: u16 = 0x0400;

    #[repr(C)]
    struct ShFileOpStructW {
        hwnd: isize,
        w_func: u32,
        p_from: *const u16,
        p_to: *const u16,
        f_flags: u16,
        f_any_operations_aborted: i32,
        h_name_mappings: *mut core::ffi::c_void,
        lpsz_progress_title: *const u16,
    }

    #[link(name = "shell32")]
    extern "system" {
        fn SHFileOperationW(lpfileop: *mut ShFileOpStructW) -> i32;
    }

    /// 将单个路径移入回收站。pFrom 要求双 NUL 结尾。
    pub fn send_to_trash(path: &str) -> Result<(), String> {
        let mut from: Vec<u16> = OsStr::new(path).encode_wide().collect();
        from.push(0);
        from.push(0);
        let mut op = ShFileOpStructW {
            hwnd: 0,
            w_func: FO_DELETE,
            p_from: from.as_ptr(),
            p_to: std::ptr::null(),
            f_flags: FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI,
            f_any_operations_aborted: 0,
            h_name_mappings: std::ptr::null_mut(),
            lpsz_progress_title: std::ptr::null(),
        };
        let rc = unsafe { SHFileOperationW(&mut op) };
        if rc == 0 && op.f_any_operations_aborted == 0 {
            Ok(())
        } else {
            Err(format!("rc={} aborted={}", rc, op.f_any_operations_aborted))
        }
    }
}

fn del_item(t: &str, path: &Path, kind: &str, status: &str, freed: u64, msg: &str, mode: &str) {
    let mut s = String::from("@@ITEM@@{\"type\":\"");
    s.push_str(t);
    s.push_str("\",\"path\":\"");
    s.push_str(&json_escape(&unix_path(path)));
    s.push_str("\",\"kind\":\"");
    s.push_str(kind);
    s.push_str("\",\"status\":\"");
    s.push_str(status);
    s.push_str("\",\"freed\":");
    s.push_str(&freed.to_string());
    s.push_str(",\"mode\":\"");
    s.push_str(mode);
    s.push_str("\",\"message\":\"");
    s.push_str(&json_escape(msg));
    s.push_str("\"}\n");
    use std::io::Write;
    let _ = std::io::stdout().write_all(s.as_bytes());
}

/// 对应主进程 isProtectedDeletePath：拒绝磁盘根与系统关键目录。
fn is_protected_path(p: &str) -> bool {
    let norm = p.trim_end_matches(|c: char| c == '\\' || c == '/');
    if norm.is_empty() {
        return true;
    }
    let bytes = norm.as_bytes();
    if bytes.len() == 2 && (bytes[0].is_ascii_alphabetic()) && bytes[1] == b':' {
        return true; // 例如 C:
    }
    let lower = norm.to_lowercase();
    // 审查v4-L1：根路径盘符跟随 SystemDrive（与主进程 isProtectedDeletePath 对齐），
    // 原硬编码 C: 在系统目录装于其他盘时不设防
    let sysdrive = std::env::var("SystemDrive")
        .unwrap_or_else(|_| "C:".to_string())
        .to_lowercase();
    let roots = [
        format!("{}\\windows", sysdrive),
        format!("{}\\program files", sysdrive),
        format!("{}\\program files (x86)", sysdrive),
        format!("{}\\programdata", sysdrive),
        format!("{}\\$recycle.bin", sysdrive),
        format!("{}\\system volume information", sysdrive),
    ];
    for r in &roots {
        let r = r.as_str();
        if lower == r {
            return true;
        }
        if let Some(rest) = lower.strip_prefix(r) {
            if rest.starts_with('\\') || rest.starts_with('/') {
                return true;
            }
        }
    }
    false
}

/// 永久删除（回收站不可用时的兜底）。
fn permanent_delete(p: &Path, kind: &str) -> Result<(), String> {
    let r = if kind == "dir" {
        fs::remove_dir_all(p)
    } else {
        fs::remove_file(p)
    };
    r.map_err(|e| e.to_string())
}

/// 删除单项：优先移入回收站（用户可还原）；目标卷不支持回收站（网络盘等）
/// 时回退为永久删除。Ok(true)=已进回收站，Ok(false)=已永久删除，Err=失败。
#[cfg(windows)]
fn delete_one(p: &Path, kind: &str) -> Result<bool, String> {
    if recycle::send_to_trash(&p.to_string_lossy()).is_ok() {
        return Ok(true);
    }
    permanent_delete(p, kind).map(|_| false)
}

#[cfg(not(windows))]
fn delete_one(p: &Path, kind: &str) -> Result<bool, String> {
    permanent_delete(p, kind).map(|_| false)
}

/// 批量删除（文件或目录）：默认移入回收站，替代原 PowerShell Remove-Item 硬删除。
/// 审查v4-L4：路径保留原始 OsString，保护判定与输出展示用 lossy 字符串即可。
fn cmd_delete(items: &[(String, OsString)]) {
    let mut ok = 0usize;
    let mut fail = 0usize;
    let mut freed: u64 = 0;
    for (kind, sp) in items {
        let p = Path::new(sp);
        if is_protected_path(&sp.to_string_lossy()) {
            fail += 1;
            del_item("delresult", p, kind, "fail", 0, "受保护的系统路径，已拒绝", "rejected");
            continue;
        }
        let sz = if kind == "dir" {
            dir_size(p)
        } else {
            fs::metadata(p).map(|m| m.len()).unwrap_or(0)
        };
        match delete_one(p, kind) {
            Ok(recycled) => {
                ok += 1;
                freed += sz;
                if recycled {
                    del_item("delresult", p, kind, "ok", sz, "已移入回收站", "recycled");
                } else {
                    del_item("delresult", p, kind, "ok", sz, "已永久删除（目标卷不支持回收站）", "permanent");
                }
            }
            Err(e) => {
                fail += 1;
                del_item("delresult", p, kind, "fail", 0, &e, "failed");
            }
        }
    }
    eprintln!("[finder-delete] ok={} fail={} freed={}", ok, fail, freed);
    progress(100);
}

fn canonical(s: &str) -> Option<PathBuf> {
    let p = Path::new(s);
    if p.exists() {
        let c = fs::canonicalize(p).ok();
        c.or(Some(p.to_path_buf()))
    } else {
        Some(p.to_path_buf())
    }
}

fn parse_u64(s: &str) -> u64 {
    s.parse().unwrap_or(0)
}

fn main() {
    // 审查v4-L4：命令名/数值参数经 lossy 转换足够，但原始 OsString 必须保留——
    // 文件路径含孤立代理对等非良构 UTF-16 时 to_string_lossy 会产生 U+FFFD，删除目标静默失配
    let raw: Vec<OsString> = std::env::args_os().skip(1).collect();
    let args: Vec<String> = raw.iter().map(|a| a.to_string_lossy().to_string()).collect();
    if args.is_empty() {
        println!("finder <duplicates|bigfiles|empty|appdata|sizes|delete> [args...]");
        return;
    }
    match args[0].as_str() {
        "duplicates" => {
            let mut min_size = 1024 * 1024u64; // 默认 1MB
            let mut roots: Vec<String> = Vec::new();
            let mut i = 1;
            while i < args.len() {
                if args[i] == "--min-size" && i + 1 < args.len() {
                    min_size = parse_u64(&args[i + 1]);
                    i += 2;
                } else {
                    roots.push(args[i].clone());
                    i += 1;
                }
            }
            if roots.is_empty() {
                println!("duplicates 需要至少一个扫描目录");
                return;
            }
            cmd_duplicates(&roots, min_size);
        }
        "bigfiles" => {
            let mut count = 50usize;
            let mut roots: Vec<String> = Vec::new();
            let mut i = 1;
            while i < args.len() {
                if args[i] == "--count" && i + 1 < args.len() {
                    count = parse_u64(&args[i + 1]) as usize;
                    i += 2;
                } else {
                    roots.push(args[i].clone());
                    i += 1;
                }
            }
            if roots.is_empty() {
                println!("bigfiles 需要至少一个扫描目录");
                return;
            }
            cmd_bigfiles(&roots, count.max(1));
        }
        "empty" => {
            let mut roots: Vec<String> = Vec::new();
            for r in args.iter().skip(1) {
                roots.push(r.clone());
            }
            if roots.is_empty() {
                println!("empty 需要至少一个扫描目录");
                return;
            }
            cmd_empty(&roots);
        }
        "appdata" => {
            let mut min_mb = 10u64;
            let mut i = 1;
            while i < args.len() {
                if args[i] == "--min-size-mb" && i + 1 < args.len() {
                    min_mb = parse_u64(&args[i + 1]);
                    i += 2;
                } else {
                    i += 1;
                }
            }
            cmd_appdata(min_mb);
        }
        "sizes" => {
            let mut paths: Vec<String> = Vec::new();
            for a in args.iter().skip(1) {
                if !a.starts_with('-') {
                    paths.push(a.clone());
                }
            }
            if paths.is_empty() {
                println!("sizes 需要至少一个路径");
                return;
            }
            cmd_sizes(&paths);
        }
        "delete" => {
            // 审查v4-L4：路径取原始 OsString，命令名与格式校验用 lossy 字符串
            let mut items: Vec<(String, OsString)> = Vec::new();
            let mut i = 1;
            while i + 1 < raw.len() {
                let kind = args[i].to_lowercase();
                let p = &args[i + 1];
                if (kind == "file" || kind == "dir") && !p.is_empty() && !p.starts_with('-') {
                    items.push((kind, raw[i + 1].clone()));
                }
                i += 2;
            }
            if items.is_empty() {
                println!("delete 需要成对的 <file|dir> <path> 参数");
                return;
            }
            cmd_delete(&items);
        }
        _ => {
            println!("未知命令: {}", args[0]);
        }
    }
}
