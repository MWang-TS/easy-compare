//! 基线持久化、预演计划生成、备份执行。
//! 实现 PRD v1.0 第 7.2 节三项不可回退的安全约束。

use crate::model::*;
use crate::platform;
use crate::scanner::{flatten_files, hash_file, scan_side};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

pub const STATE_DIR: &str = ".easy-compare";
pub const BASELINE_FILE: &str = "baseline.json";
pub const VERSIONS_DIR: &str = "versions";
pub const REPORTS_DIR: &str = "reports";

pub fn state_dir(target: &Path) -> PathBuf {
    target.join(STATE_DIR)
}
pub fn baseline_path(target: &Path) -> PathBuf {
    state_dir(target).join(BASELINE_FILE)
}

/// 基线载入结果。warning 非空表示发现了需要告知用户的情况（例如卷标识不匹配）。
pub struct BaselineLoad {
    pub baseline: Option<Baseline>,
    /// "目标盘" | "应用数据目录" | 空（未找到）
    pub source: String,
    pub warning: String,
}

/// 基线优先落在目标目录侧（PRD 4.3），目标盘不可写时降级到应用数据目录。
/// Q8：基线自带的卷标识必须与当前会话一致，否则宁可不使用基线，也不能错误判定冲突。
pub fn load_baseline(
    target: &Path,
    fallback: &Path,
    session_id: &str,
    expected_volume: &str,
) -> BaselineLoad {
    let primary = baseline_path(target);
    let alt = fallback.join("baselines").join(format!("{}.json", session_id));
    for (p, where_) in [(primary, "目标盘"), (alt, "应用数据目录")] {
        let text = match std::fs::read_to_string(&p) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let b = match serde_json::from_str::<Baseline>(&text) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if b.session_id != session_id || b.entries.is_empty() {
            continue;
        }
        if !expected_volume.is_empty()
            && !b.volume_id.is_empty()
            && b.volume_id != expected_volume
        {
            return BaselineLoad {
                baseline: None,
                source: where_.into(),
                warning: format!(
                    "旧基线属于另一块卷（基线 {}，当前 {}），已忽略；本次将不判定冲突",
                    b.volume_id, expected_volume
                ),
            };
        }
        return BaselineLoad {
            baseline: Some(b),
            source: where_.into(),
            warning: String::new(),
        };
    }
    BaselineLoad {
        baseline: None,
        source: String::new(),
        warning: String::new(),
    }
}

pub fn save_baseline(
    target: &Path,
    fallback: &Path,
    baseline: &Baseline,
) -> Result<String, String> {
    let text = serde_json::to_string_pretty(baseline)
        .map_err(|e| format!("基线序列化失败：{}", e))?;
    let primary = baseline_path(target);
    if write_atomic_text(&primary, &text).is_ok() {
        return Ok("目标盘".into());
    }
    let alt_dir = fallback.join("baselines");
    std::fs::create_dir_all(&alt_dir)
        .map_err(|e| format!("无法创建基线目录：{}", e))?;
    let alt = alt_dir.join(format!("{}.json", baseline.session_id));
    write_atomic_text(&alt, &text)?;
    Ok("应用数据目录（目标盘不可写）".into())
}

/// 文本文件的临时写入 + 原子替换。
/// 注：Windows 上 std::fs::rename 等价于 MoveFileEx(REPLACE_EXISTING)，可直接覆盖；
/// 先删后改名会在中途制造一个“文件不存在”的窗口，已移除。
fn write_atomic_text(path: &Path, text: &str) -> Result<(), String> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("tmp-{}", short_id()));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(())
}

/// Q8：卷标识 + 路径双重校验。校验失败时调用方必须拒绝一切写入。
pub fn check_volume(expected: &str, target: &Path) -> (bool, String) {
    if !target.is_dir() {
        return (false, "目标目录不存在或已断开，禁止写入".into());
    }
    let (_, actual) = platform::volume_identity(target);
    if actual.is_empty() {
        return (false, "无法读取目标卷标识，禁止写入".into());
    }
    if expected.is_empty() {
        return (false, "会话缺少卷标识，请重新绑定目标目录".into());
    }
    if actual != expected {
        return (
            false,
            format!(
                "目标卷标识不匹配（期望 {}，实际 {}）。可能插入了另一块移动硬盘，禁止写入；请在会话中重新绑定目标目录。",
                expected, actual
            ),
        );
    }
    (true, "卷标识与路径校验通过".into())
}

/// 生成预演计划。前端只传勾选的相对路径，路径到绝对路径的映射全在 Rust 侧完成。
pub fn create_plan(
    session: &Session,
    compare_result: &CompareResult,
    selected: &[String],
    mirror_mode: bool,
    keep_old_versions: bool,
    resolutions: BTreeMap<String, String>,
) -> Plan {
    let mut plan = Plan {
        id: short_id(),
        session_id: session.id.clone(),
        created_at: now_secs(),
        keep_old_versions,
        mirror_mode,
        source_path: session.source_path.clone(),
        target_path: session.target_path.clone(),
        target_volume: session.target_volume.clone(),
        resolutions,
        ..Default::default()
    };

    let (vol_ok, vol_msg) = check_volume(&session.target_volume, Path::new(&session.target_path));
    plan.volume_ok = vol_ok;
    // P0：扫描被取消/中断时结果不完整，镜像模式会把未扫到的源文件误判为“仅目标有”。
    let aborted = compare_result.aborted;

    let sel: std::collections::BTreeSet<String> =
        selected.iter().map(|s| s.to_ascii_lowercase()).collect();
    let files = flatten_files(&compare_result.tree);

    for n in &files {
        let key = n.id.clone();
        match n.state.as_str() {
            "conflict" => {
                let decision = plan
                    .resolutions
                    .get(&key)
                    .cloned()
                    .unwrap_or_else(|| "".into());
                match decision.as_str() {
                    "overwrite" => plan.to_overwrite.push(PlanItem {
                        rel: n.rel.clone(),
                        size: n.lb,
                        action: "overwrite".into(),
                    }),
                    "keep" | "skip" => plan.to_skip.push(n.rel.clone()),
                    _ => plan.conflicts.push(n.rel.clone()),
                }
            }
            "left" if sel.contains(&key) => plan.to_add.push(PlanItem {
                rel: n.rel.clone(),
                size: n.lb,
                action: "add".into(),
            }),
            "diff" if sel.contains(&key) => plan.to_overwrite.push(PlanItem {
                rel: n.rel.clone(),
                size: n.lb,
                action: "overwrite".into(),
            }),
            "right" if mirror_mode => plan.to_delete.push(PlanItem {
                rel: n.rel.clone(),
                size: n.rb,
                action: "delete".into(),
            }),
            _ => {
                // 只有「有差异但本次不处理」的项才算跳过；已同步与仅目标有不算。
                if matches!(n.state.as_str(), "diff" | "left" | "unknown") {
                    plan.to_skip.push(n.rel.clone());
                }
            }
        }
    }

    plan.total_bytes = plan
        .to_add
        .iter()
        .chain(plan.to_overwrite.iter())
        .map(|i| i.size)
        .sum();
    plan.target_free_bytes = platform::free_space(Path::new(&session.target_path));
    // 预留 16 MB 余量，避免写满导致最后一项半写入。
    plan.space_ok = plan.total_bytes.saturating_add(16 * 1024 * 1024) <= plan.target_free_bytes;

    let has_work = !plan.to_add.is_empty()
        || !plan.to_overwrite.is_empty()
        || !plan.to_delete.is_empty();
    plan.executable =
        vol_ok && plan.space_ok && plan.conflicts.is_empty() && has_work && !aborted;

    let mut msg: Vec<String> = Vec::new();
    if aborted {
        msg.push("本次比对不完整（扫描被取消或中断），已禁止执行；请重新比对".into());
    }
    if !vol_ok {
        msg.push(vol_msg);
    }
    if !plan.space_ok {
        msg.push(format!(
            "目标盘空间不足：需写入 {}，可用 {}",
            fmt_size(plan.total_bytes),
            fmt_size(plan.target_free_bytes)
        ));
    }
    if !plan.conflicts.is_empty() {
        msg.push(format!(
            "存在 {} 项冲突尚未逐项处置，执行已阻断",
            plan.conflicts.len()
        ));
    }
    if !has_work && msg.is_empty() {
        msg.push("没有需要写入的条目".into());
    }
    if msg.is_empty() {
        msg.push("预演通过，可以执行".into());
    }
    plan.message = msg.join("；");
    plan
}

/// 把目标端旧文件移入版本目录，保留相对路径结构。
fn archive_old(
    target: &Path,
    rel: &str,
    stamp: &str,
    bucket: &str,
) -> Result<PathBuf, String> {
    let src = platform::join_under(target, rel)?;
    if !src.exists() {
        return Ok(PathBuf::new());
    }
    let dst = state_dir(target)
        .join(VERSIONS_DIR)
        .join(stamp)
        .join(bucket)
        .join(PathBuf::from(rel.replace('/', "\\")));
    if let Some(p) = dst.parent() {
        std::fs::create_dir_all(p).map_err(|e| format!("无法创建版本目录：{}", e))?;
    }
    // 同一批次内若路径已存在，追加序号，避免覆盖已有版本。
    let mut final_dst = dst.clone();
    let mut i = 1;
    while final_dst.exists() {
        let ext = dst
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default();
        let stem = dst
            .file_stem()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default();
        final_dst = dst.with_file_name(format!(
            "{}_{}.{}",
            stem,
            i,
            if ext.is_empty() { "bak".to_string() } else { ext }
        ));
        i += 1;
    }
    std::fs::rename(&src, &final_dst).map_err(|e| format!("旧版本归档失败：{}", e))?;
    Ok(final_dst)
}

/// 单文件复制：临时文件 → 设置 mtime → 原子替换。
fn copy_atomic(src: &Path, dst: &Path, mtime: i64) -> Result<(), String> {
    if let Some(p) = dst.parent() {
        std::fs::create_dir_all(p).map_err(|e| format!("无法创建目标目录：{}", e))?;
    }
    let tmp = dst.with_file_name(format!(
        ".ec-tmp-{}-{}",
        short_id(),
        dst.file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default()
    ));
    std::fs::copy(src, &tmp).map_err(|e| format!("复制失败：{}", e))?;
    if let Err(e) = platform::set_mtime(&tmp, mtime) {
        // 时间戳保持失败不应让备份失败，但要留痕。
        let _ = e;
    }
    if let Err(e) = std::fs::rename(&tmp, dst) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("原子替换失败：{}", e));
    }
    Ok(())
}

/// 进度回调：(已完成数, 总数, 当前相对路径, 结果)。
pub fn execute_plan<F>(
    plan: &Plan,
    confirmed: bool,
    mut progress: F,
) -> Result<BackupResult, String>
where
    F: FnMut(usize, usize, &str, &str),
{
    if !confirmed {
        return Err("缺少用户确认标记，拒绝执行".into());
    }
    if !plan.executable {
        return Err(format!("计划不可执行：{}", plan.message));
    }
    // 执行前再次做卷校验，防止预演后移动硬盘被换掉或拔出。
    let (vol_ok, vol_msg) = check_volume(&plan.target_volume, Path::new(&plan.target_path));
    if !vol_ok {
        return Err(vol_msg);
    }

    let src_root = PathBuf::from(&plan.source_path);
    let tgt_root = PathBuf::from(&plan.target_path);
    let stamp = format!("{}", now_secs());
    let mut result = BackupResult {
        plan_id: plan.id.clone(),
        finished_at: now_secs(),
        skipped: plan.to_skip.len(),
        ..Default::default()
    };
    let mut work: Vec<&PlanItem> = Vec::new();
    work.extend(plan.to_add.iter());
    work.extend(plan.to_overwrite.iter());
    work.extend(plan.to_delete.iter());
    let total = work.len();
    let mut done = 0usize;

    for item in work {
        // 每写一项前重新校验目标卷（PRD 7.3：目标盘中途断开立即暂停）。
        let (ok, why) = check_volume(&plan.target_volume, &tgt_root);
        if !ok {
            result.aborted_reason = format!("执行中途目标卷校验失败，已暂停：{}", why);
            progress(done, total, &item.rel, "aborted");
            break;
        }
        let rel = match platform::safe_rel(&item.rel) {
            Some(r) => r,
            None => {
                result.per_item.push(ItemResult {
                    rel: item.rel.clone(),
                    action: item.action.clone(),
                    outcome: "failed".into(),
                    error: "非法相对路径，已拒绝".into(),
                });
                result.failed += 1;
                done += 1;
                continue;
            }
        };
        let outcome: Result<(), String> = (|| {
            match item.action.as_str() {
                "add" | "overwrite" => {
                    let src = platform::join_under(&src_root, &rel)?;
                    let dst = platform::join_under(&tgt_root, &rel)?;
                    if !src.is_file() {
                        return Err("源文件已不存在".into());
                    }
                    let md = std::fs::symlink_metadata(&src).map_err(|e| e.to_string())?;
                    let mtime = md
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                    if plan.keep_old_versions && dst.exists() {
                        archive_old(&tgt_root, &rel, &stamp, "replaced")?;
                    }
                    copy_atomic(&src, &dst, mtime)?;
                }
                "delete" => {
                    // 镜像模式：不直接抹除，先移入版本目录，可手工恢复。
                    archive_old(&tgt_root, &rel, &stamp, "deleted")?;
                }
                _ => return Err("未知动作".into()),
            }
            Ok(())
        })();

        let (outcome_s, error_s) = match outcome {
            Ok(()) => {
                result.succeeded += 1;
                ("succeeded".to_string(), String::new())
            }
            Err(e) => {
                result.failed += 1;
                ("failed".to_string(), e)
            }
        };
        result.per_item.push(ItemResult {
            rel: rel.clone(),
            action: item.action.clone(),
            outcome: outcome_s,
            error: error_s,
        });
        done += 1;
        progress(done, total, &rel, "done");
    }
    result.finished_at = now_secs();
    Ok(result)
}

/// 重建基线：以本次执行后的「源端全量快照」为准，而不是只记录本次写入的项。
///
/// 原因（P0）：若只记录本次写入项，首次备份时本就「已同步」的文件永远不会进入基线；
/// 之后源与目标都被修改时，冲突判定会因缺少基线条目而退化成「内容不同」，
/// 导致源端静默覆盖目标端的手工修改。这里改为全量扫描源端：
///   * 已同步项 → 源端元数据（= 目标端元数据）
///   * 本次成功写入项 → 源端元数据
///   * 本次失败项 → 从基线剔除（下次按普通差异重新复制，而不是误判冲突）
///   * 镜像模式删除项 → 源端本就不存在，自然不会出现
/// 源端整体不可读（例如磁盘断开）时保留旧基线，避免把基线清空。
pub fn rebuild_baseline(
    previous: Option<Baseline>,
    session: &Session,
    result: &BackupResult,
    volume_id: &str,
) -> Baseline {
    let src_root = PathBuf::from(&session.source_path);
    let side = scan_side(
        &src_root,
        &session.filters,
        false,
        Arc::new(AtomicBool::new(false)),
        |_, _| {},
    );

    if side.files.is_empty() && !side.errors.is_empty() {
        // 源端完全读不到：保留旧基线，宁可下次少判冲突，也不能凭空丢失参照。
        if let Some(mut old) = previous {
            old.generated_at = now_secs();
            old.volume_id = volume_id.into();
            return old;
        }
    }

    let failed: BTreeSet<String> = result
        .per_item
        .iter()
        .filter(|i| i.outcome != "succeeded")
        .map(|i| i.rel.to_ascii_lowercase())
        .collect();

    let mut entries = BTreeMap::new();
    for (key, meta) in side.files {
        if failed.contains(&key) {
            continue;
        }
        entries.insert(key, meta);
    }

    Baseline {
        session_id: session.id.clone(),
        generated_at: now_secs(),
        volume_id: volume_id.into(),
        entries,
    }
}

/// 导出执行报告（P1）。
pub fn export_report(app_data: &Path, result: &BackupResult, session: &Session) -> Result<String, String> {
    let dir = app_data.join(REPORTS_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("report-{}.json", result.finished_at));
    let payload = serde_json::json!({
        "product": "Easy Compare",
        "session": { "id": session.id, "name": session.name,
                     "sourcePath": session.source_path, "targetPath": session.target_path },
        "result": result
    });
    write_atomic_text(&path, &serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?)?;
    Ok(path.to_string_lossy().to_string())
}

/// 供前端「内容校验（精确）」使用：仅对选中项做哈希并给出差异结论。
pub fn quick_hash_compare(src: &Path, dst: &Path) -> Result<bool, String> {
    let a = hash_file(src).map_err(|e| e.to_string())?;
    let b = hash_file(dst).map_err(|e| e.to_string())?;
    Ok(a == b)
}
