//! 递归扫描、六态判定与双栏树构建。
//! 状态机判定顺序严格遵循 PRD v1.0 第 3 节：冲突 → 仅源有 → 仅目标有 → 内容不同 → 已同步 → 未比对。

use crate::model::*;
use crate::platform;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// 跨文件系统时间戳容差（秒）。
/// 说明：FAT/exFAT 与 NTFS 的时间戳粒度与时区语义不同，可能导致「内容相同但被判差异」。
/// 该数值是工程假设，PRD 已把它列为待实测项，此处不宣称其为量化结论。
pub const MTIME_TOLERANCE_SECS: i64 = 2;

/// 单侧扫描结果。对齐键统一为小写、/ 分隔的相对路径。
#[derive(Debug, Default)]
pub struct ScanSide {
    pub files: BTreeMap<String, FileMeta>,
    /// 对齐键 -> 磁盘上的原始相对路径（用于显示与大小写冲突检测）
    pub display: BTreeMap<String, String>,
    pub dirs: BTreeSet<String>,
    pub errors: BTreeMap<String, String>,
    pub skipped_links: usize,
    /// 扫描因取消请求或安全上限而提前结束，结果不完整。
    pub aborted: bool,
}

fn meta_of(path: &Path) -> std::io::Result<FileMeta> {
    let md = std::fs::symlink_metadata(path)?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    Ok(FileMeta {
        size: md.len(),
        mtime,
        hash: None,
    })
}

pub fn hash_file(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 递归扫描一侧目录。progress 回调参数为 (已扫描文件数, 当前相对路径)。
pub fn scan_side<F>(
    root: &Path,
    filters: &Filters,
    with_hash: bool,
    cancel: Arc<AtomicBool>,
    mut progress: F,
) -> ScanSide
where
    F: FnMut(usize, &str),
{
    let mut side = ScanSide::default();
    let mut stack: Vec<(PathBuf, String)> = vec![(root.to_path_buf(), String::new())];
    // 符号链接/目录联接保护：记录已访问的规范化路径，避免成环。
    let mut visited: BTreeSet<PathBuf> = BTreeSet::new();
    let mut depth_guard = 0usize;

    while let Some((dir, prefix)) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        depth_guard += 1;
        if depth_guard > 200_000 {
            side.errors.insert(
                "*".into(),
                "扫描条目数超过安全上限，已提前终止".into(),
            );
            side.aborted = true;
            break;
        }
        let canon = std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
        if !visited.insert(canon) {
            continue;
        }
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(e) => {
                let k = if prefix.is_empty() {
                    "*".to_string()
                } else {
                    prefix.to_ascii_lowercase()
                };
                side.errors.insert(k, format!("目录不可读：{}", e));
                continue;
            }
        };
        for ent in rd.flatten() {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let name = ent.file_name().to_string_lossy().to_string();
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", prefix, name)
            };
            let key = rel.to_ascii_lowercase();
            let path = ent.path();
            let sym = match std::fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(e) => {
                    side.errors.insert(key.clone(), format!("读取失败：{}", e));
                    continue;
                }
            };
            if sym.file_type().is_symlink() {
                // PRD 7.3：符号链接/目录联接不递归，避免成环；标注为未比对。
                side.skipped_links += 1;
                side.errors.insert(key, "已跳过符号链接或目录联接".into());
                continue;
            }
            if sym.is_dir() {
                if filters.is_dir_excluded(&name) {
                    continue;
                }
                side.dirs.insert(key.clone());
                side.display.insert(key, rel.clone());
                stack.push((path, rel));
                continue;
            }
            if filters.is_file_excluded(&name) {
                continue;
            }
            match meta_of(&path) {
                Ok(mut m) => {
                    if with_hash {
                        match hash_file(&path) {
                            Ok(h) => m.hash = Some(h),
                            Err(e) => {
                                side.errors
                                    .insert(key.clone(), format!("哈希计算失败：{}", e));
                            }
                        }
                    }
                    progress(side.files.len() + 1, &rel);
                    side.display.insert(key.clone(), rel);
                    side.files.insert(key, m);
                }
                Err(e) => {
                    side.errors.insert(key, format!("读取失败：{}", e));
                }
            }
        }
    }
    // 取消标志可能在任意时刻置位；只要置位就视为结果不完整。
    if cancel.load(Ordering::Relaxed) {
        side.aborted = true;
    }
    side
}

/// 快速比对：大小 + 修改时间（带跨文件系统容差）；哈希规则下优先用哈希。
pub fn meta_matches(a: &FileMeta, b: &FileMeta, use_hash: bool) -> bool {
    if let (Some(x), Some(y)) = (&a.hash, &b.hash) {
        return x == y;
    }
    if use_hash {
        // 请求精确校验但哈希缺失时不能判定为相同，交由上层重新计算。
        return false;
    }
    a.size == b.size && (a.mtime - b.mtime).abs() <= MTIME_TOLERANCE_SECS
}

fn changed(cur: &FileMeta, base: &FileMeta) -> bool {
    cur.size != base.size || (cur.mtime - base.mtime).abs() > MTIME_TOLERANCE_SECS
}

#[derive(Debug, Clone)]
struct Flat {
    key: String,
    rel: String,
    state: EntryState,
    left: Option<FileMeta>,
    right: Option<FileMeta>,
    nw: String,
    err: String,
    /// 目录节点在源侧/目标侧实际存在（文件节点用 left/right 判断）。
    dl: bool,
    dr: bool,
}

/// 六态判定 + 树构建。
pub fn compare(
    side_l: &ScanSide,
    side_r: &ScanSide,
    baseline: Option<&Baseline>,
    use_hash: bool,
) -> (Vec<TreeNode>, StateCounts, Vec<String>) {
    let mut keys: BTreeSet<String> = BTreeSet::new();
    keys.extend(side_l.files.keys().cloned());
    keys.extend(side_r.files.keys().cloned());
    keys.extend(side_l.dirs.iter().cloned());
    keys.extend(side_r.dirs.iter().cloned());
    keys.extend(side_l.errors.keys().cloned());
    keys.extend(side_r.errors.keys().cloned());
    // 基线里已消失的条目也要出现在结果中，才能正确显示「仅目标有」等状态。
    if let Some(b) = baseline {
        keys.extend(b.entries.keys().cloned());
    }

    let mut flats: Vec<Flat> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    for key in keys {
        let l = side_l.files.get(&key);
        let r = side_r.files.get(&key);
        let is_dir = side_l.dirs.contains(&key) || side_r.dirs.contains(&key);
        let err_l = side_l.errors.get(&key);
        let err_r = side_r.errors.get(&key);
        let rel = side_l
            .display
            .get(&key)
            .or_else(|| side_r.display.get(&key))
            .cloned()
            .unwrap_or_else(|| key.clone());

        // 目录节点不参与写入判定，仅作为容器；这里先占位，稍后汇总子树。
        if is_dir {
            flats.push(Flat {
                dl: side_l.dirs.contains(&key),
                dr: side_r.dirs.contains(&key),
                key: key.clone(),
                rel,
                state: EntryState::Unknown,
                left: None,
                right: None,
                nw: String::new(),
                err: String::new(),
            });
            continue;
        }

        let mut err = String::new();
        if let Some(e) = err_l {
            err = format!("源：{}", e);
        } else if let Some(e) = err_r {
            err = format!("目标：{}", e);
        }

        let state = if err_l.is_some() || err_r.is_some() {
            // 6. 未比对：读取异常优先，不参与批量操作。
            EntryState::Unknown
        } else {
            match (l, r) {
                (Some(a), Some(b)) => {
                    // 1. 冲突：有基线，且两端相对基线均发生变化。
                    let conflict = baseline
                        .and_then(|base| base.entries.get(&key))
                        .map(|base| changed(a, base) && changed(b, base))
                        .unwrap_or(false);
                    if conflict {
                        EntryState::Conflict
                    } else if meta_matches(a, b, use_hash) {
                        // 5. 已同步
                        EntryState::Ok
                    } else {
                        // 4. 内容不同
                        EntryState::Diff
                    }
                }
                // 2. 仅源有
                (Some(_), None) => EntryState::Left,
                // 3. 仅目标有
                (None, Some(_)) => EntryState::Right,
                (None, None) => {
                    // 基线残留且两端均已不存在：视为未比对，避免误判为可删除。
                    EntryState::Unknown
                }
            }
        };

        // 同名大小写冲突（PRD 7.3）：键相同但磁盘上的大小写不同，不自动覆盖。
        let case_clash = match (side_l.display.get(&key), side_r.display.get(&key)) {
            (Some(a), Some(b)) => a != b,
            _ => false,
        };
        let state = if case_clash && state != EntryState::Unknown {
            warnings.push(format!("同名大小写冲突，已阻断自动覆盖：{}", rel));
            err = "源与目标文件名大小写不一致".into();
            EntryState::Conflict
        } else {
            state
        };

        let nw = match state {
            EntryState::Diff | EntryState::Conflict => match (l, r) {
                (Some(a), Some(b)) => {
                    if a.mtime > b.mtime {
                        "source"
                    } else if b.mtime > a.mtime {
                        "target"
                    } else if a.size >= b.size {
                        "source"
                    } else {
                        "target"
                    }
                    .to_string()
                }
                _ => String::new(),
            },
            _ => String::new(),
        };

        flats.push(Flat {
            key,
            rel,
            state,
            left: l.cloned(),
            right: r.cloned(),
            nw,
            err,
            dl: false,
            dr: false,
        });
    }

    // 无基线时只按方向规则降级处理，不再向界面推送提示（首次比对必然无基线，
    // 每次都弹告警行会占用版面并淹没真正需要注意的异常）。
    let (tree, counts) = build_tree(flats);
    (tree, counts, warnings)
}

fn dir_state(children: &[TreeNode]) -> EntryState {
    // 汇总优先级与原型一致：冲突 > 需更新 > 仅源有 > 仅目标有 > 已同步
    let has = |s: &str| children.iter().any(|c| c.state == s);
    if has("conflict") {
        EntryState::Conflict
    } else if has("diff") {
        EntryState::Diff
    } else if has("left") {
        EntryState::Left
    } else if has("right") {
        EntryState::Right
    } else if has("unknown") {
        EntryState::Unknown
    } else {
        EntryState::Ok
    }
}

fn build_tree(flats: Vec<Flat>) -> (Vec<TreeNode>, StateCounts) {
    let mut counts = StateCounts::default();
    // 用 BTreeMap 按路径层级组装，key 为完整对齐键。
    let mut map: BTreeMap<String, TreeNode> = BTreeMap::new();
    // 收集所有祖先目录键，保证扁平文件能挂到树上。
    let mut all_dirs: BTreeSet<String> = BTreeSet::new();
    // 目录在源侧 / 目标侧的真实存在性（用于双栏 ghost 态）。
    let mut dir_l: BTreeSet<String> = BTreeSet::new();
    let mut dir_r: BTreeSet<String> = BTreeSet::new();

    for f in &flats {
        let parts: Vec<&str> = f.key.split('/').collect();
        for i in 1..parts.len() {
            all_dirs.insert(parts[..i].join("/"));
        }
    }

    for f in flats {
        let name = f.rel.rsplit('/').next().unwrap_or(&f.rel).to_string();
        // 目录判定以「在任一侧被扫描为目录」为准；空目录没有子项，
        // 不能靠祖先路径推断，否则会被误判成文件。
        let is_dir = f.dl || f.dr;
        if is_dir {
            if f.dl {
                dir_l.insert(f.key.clone());
            }
            if f.dr {
                dir_r.insert(f.key.clone());
            }
        }
        if f.state != EntryState::Unknown || !f.err.is_empty() || f.left.is_some() || f.right.is_some() {
            match f.state {
                EntryState::Ok => counts.ok += 1,
                EntryState::Diff => counts.diff += 1,
                EntryState::Left => counts.left += 1,
                EntryState::Right => counts.right += 1,
                EntryState::Conflict => counts.conflict += 1,
                EntryState::Unknown => counts.unknown += 1,
            }
            counts.total += 1;
        }
        let (_, _, lt, rt) = side_labels(f.state, &f.nw, &f.err, is_dir);
        map.insert(
            f.key.clone(),
            TreeNode {
                id: f.key.clone(),
                rel: f.rel.clone(),
                name,
                kind: if is_dir { "dir" } else { "file" }.into(),
                state: if is_dir {
                    EntryState::Ok.as_str().into()
                } else {
                    f.state.as_str().into()
                },
                l: f.left.as_ref().map(|m| fmt_size(m.size)).unwrap_or_default(),
                r: f.right.as_ref().map(|m| fmt_size(m.size)).unwrap_or_default(),
                lb: f.left.as_ref().map(|m| m.size).unwrap_or(0),
                rb: f.right.as_ref().map(|m| m.size).unwrap_or(0),
                lt,
                rt,
                nw: f.nw.clone(),
                err: f.err.clone(),
                // 目录节点只在对应侧真实存在时才拥有该侧内容，
                // 否则前端会误把「仅源有目录」显示成双侧都有。
                has_l: if is_dir { f.dl } else { f.left.is_some() },
                has_r: if is_dir { f.dr } else { f.right.is_some() },
                children: Vec::new(),
            },
        );
    }

    // 补齐只作为祖先出现的目录（例如空目录）。
    for d in &all_dirs {
        map.entry(d.clone()).or_insert_with(|| {
            let name = d.rsplit('/').next().unwrap_or(d).to_string();
            TreeNode {
                id: d.clone(),
                rel: d.clone(),
                name,
                kind: "dir".into(),
                state: "ok".into(),
                has_l: dir_l.contains(d),
                has_r: dir_r.contains(d),
                ..Default::default()
            }
        });
    }

    // 自底向上挂接：按深度降序处理。
    let mut keys: Vec<String> = map.keys().cloned().collect();
    keys.sort_by(|a, b| {
        let da = a.matches('/').count();
        let db = b.matches('/').count();
        db.cmp(&da).then_with(|| b.cmp(a))
    });

    for key in keys {
        if let Some(parent) = key.rsplit_once('/').map(|(p, _)| p.to_string()) {
            if parent.is_empty() {
                continue;
            }
            if let Some(node) = map.get(&key).cloned() {
                if let Some(p) = map.get_mut(&parent) {
                    p.children.push(node);
                }
            }
        }
    }

    // 自顶向下汇总目录状态与计数标签。
    fn finalize(n: &mut TreeNode, counts: &mut StateCounts) {
        if n.kind == "dir" {
            for c in &mut n.children {
                finalize(c, counts);
            }
            n.children.sort_by(|a, b| {
                let ka = (a.kind != "dir", a.name.to_ascii_lowercase());
                let kb = (b.kind != "dir", b.name.to_ascii_lowercase());
                ka.cmp(&kb)
            });
            let mut st = dir_state(&n.children);
            // 空目录或子树已同步但目录本身只在单侧存在时，目录状态取存在性方向。
            if n.children.is_empty() {
                if !n.has_r {
                    st = EntryState::Left;
                } else if !n.has_l {
                    st = EntryState::Right;
                }
            }
            n.state = st.as_str().into();
            let d: usize = n
                .children
                .iter()
                .filter(|c| ["diff", "left", "conflict"].contains(&c.state.as_str()))
                .count();
            let label = if d > 0 {
                format!("子树 {} 处差异", d)
            } else {
                "全部已同步".to_string()
            };
            // 单侧存在的目录要明确说出方向，否则「仅目标有」的目录会显示成「全部已同步」。
            n.lt = if !n.has_l {
                "缺失".into()
            } else if !n.has_r {
                "待新增".into()
            } else {
                label.clone()
            };
            n.rt = if !n.has_r {
                "缺失".into()
            } else if !n.has_l {
                "全部保留".into()
            } else {
                label
            };
        }
    }
    let mut roots: Vec<TreeNode> = map
        .into_iter()
        .filter(|(k, _)| !k.contains('/'))
        .map(|(_, mut n)| {
            finalize(&mut n, &mut counts);
            n
        })
        .collect();
    roots.sort_by(|a, b| {
        let ka = (a.kind != "dir", a.name.to_ascii_lowercase());
        let kb = (b.kind != "dir", b.name.to_ascii_lowercase());
        ka.cmp(&kb)
    });
    (roots, counts)
}

fn side_labels(
    st: EntryState,
    nw: &str,
    err: &str,
    is_dir: bool,
) -> (String, String, String, String) {
    if is_dir {
        return (String::new(), String::new(), String::new(), String::new());
    }
    if st == EntryState::Unknown {
        let e = if err.is_empty() { "未比对" } else { "读取异常" };
        return (String::new(), String::new(), e.into(), e.into());
    }
    match st {
        EntryState::Ok => (
            String::new(),
            String::new(),
            "已同步".into(),
            "已同步".into(),
        ),
        EntryState::Left => (
            String::new(),
            String::new(),
            "待新增".into(),
            "缺失".into(),
        ),
        EntryState::Right => (
            String::new(),
            String::new(),
            "源端已无".into(),
            "默认保留".into(),
        ),
        EntryState::Conflict => (
            String::new(),
            String::new(),
            "两侧均已改动".into(),
            "两侧均已改动".into(),
        ),
        EntryState::Diff => {
            if nw == "target" {
                (
                    String::new(),
                    String::new(),
                    "源较旧（慎覆盖）".into(),
                    "目标较新".into(),
                )
            } else {
                (
                    String::new(),
                    String::new(),
                    "源较新".into(),
                    "目标较旧".into(),
                )
            }
        }
        _ => (String::new(), String::new(), err.into(), err.into()),
    }
}

/// 供前端做「全选差异」：返回可参与写入的文件相对路径（原始大小写）。
pub fn selectable_paths(tree: &[TreeNode]) -> Vec<String> {
    fn walk(n: &[TreeNode], out: &mut Vec<String>) {
        for x in n {
            if x.kind == "file" && (x.state == "left" || x.state == "diff") {
                out.push(x.rel.clone());
            }
            walk(&x.children, out);
        }
    }
    let mut out = Vec::new();
    walk(tree, &mut out);
    out
}

pub fn find_node<'a>(tree: &'a [TreeNode], key: &str) -> Option<&'a TreeNode> {
    let k = key.to_ascii_lowercase();
    fn walk<'a>(n: &'a [TreeNode], k: &str) -> Option<&'a TreeNode> {
        for x in n {
            if x.id == k {
                return Some(x);
            }
            if let Some(f) = walk(&x.children, k) {
                return Some(f);
            }
        }
        None
    }
    walk(tree, &k)
}

/// 从树中取全部文件节点（扁平），用于计划生成。
pub fn flatten_files(tree: &[TreeNode]) -> Vec<TreeNode> {
    fn walk(n: &[TreeNode], out: &mut Vec<TreeNode>) {
        for x in n {
            if x.kind == "file" {
                out.push(x.clone());
            }
            walk(&x.children, out);
        }
    }
    let mut out = Vec::new();
    walk(tree, &mut out);
    out
}

/// 六态计数（只统计文件节点，目录不参与）。
pub fn count_states(tree: &[TreeNode]) -> StateCounts {
    let mut counts = StateCounts::default();
    for f in flatten_files(tree) {
        match f.state.as_str() {
            "ok" => counts.ok += 1,
            "diff" => counts.diff += 1,
            "left" => counts.left += 1,
            "right" => counts.right += 1,
            "conflict" => counts.conflict += 1,
            _ => counts.unknown += 1,
        }
        counts.total += 1;
    }
    counts
}

/// 计算选中项的哈希并更新比对结果（Q2：只对选中项计算，不触发全量重算）。
pub fn verify_selected(
    root_l: &Path,
    root_r: &Path,
    tree: &mut Vec<TreeNode>,
    selected: &[String],
) -> Result<usize, String> {
    let wanted: BTreeSet<String> = selected.iter().map(|s| s.to_ascii_lowercase()).collect();
    let mut updated = 0usize;

    fn walk(
        nodes: &mut [TreeNode],
        wanted: &BTreeSet<String>,
        root_l: &Path,
        root_r: &Path,
        updated: &mut usize,
    ) {
        for n in nodes.iter_mut() {
            if n.kind == "file" && wanted.contains(&n.id) && n.has_l && n.has_r {
                let pl = platform::join_under(root_l, &n.rel);
                let pr = platform::join_under(root_r, &n.rel);
                if let (Ok(pl), Ok(pr)) = (pl, pr) {
                    let hl = hash_file(&pl).ok();
                    let hr = hash_file(&pr).ok();
                    if let (Some(a), Some(b)) = (hl, hr) {
                        if a == b && n.state != "conflict" {
                            n.state = "ok".into();
                            n.lt = "哈希一致".into();
                            n.rt = "哈希一致".into();
                        } else if a != b && n.state == "ok" {
                            n.state = "diff".into();
                            n.lt = "哈希不同".into();
                            n.rt = "哈希不同".into();
                        }
                        *updated += 1;
                    }
                }
            }
            walk(&mut n.children, wanted, root_l, root_r, updated);
        }
    }
    walk(tree, &wanted, root_l, root_r, &mut updated);
    // 目录汇总状态需要重算。
    fn redo(nodes: &mut [TreeNode]) {
        for n in nodes.iter_mut() {
            if n.kind == "dir" {
                redo(&mut n.children);
                n.state = dir_state(&n.children).as_str().into();
            }
        }
    }
    redo(tree);
    Ok(updated)
}
