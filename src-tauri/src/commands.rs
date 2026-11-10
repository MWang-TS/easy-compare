//! Tauri IPC 命令层。
//! 安全边界：前端只传会话标识、相对路径与开关；任何绝对路径到磁盘的映射都在 Rust 侧完成并校验。

use crate::backup;
use crate::model::*;
use crate::platform;
use crate::scanner;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

#[derive(Default)]
pub struct AppState {
    pub sessions: BTreeMap<String, Session>,
    pub active_session: Option<String>,
    pub last_compare: Option<CompareResult>,
    pub baseline: Option<Baseline>,
    pub plans: BTreeMap<String, Plan>,
    pub last_result: Option<BackupResult>,
    pub scan_cancel: Arc<AtomicBool>,
    pub scanning: bool,
}

pub type SharedState = Mutex<AppState>;

fn sessions_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("sessions.json"))
}

fn app_data(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 界面状态（目前只存「上次使用的会话」），与会话列表分开保存，避免破坏旧文件格式。
fn ui_state_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("ui_state.json"))
}

pub fn load_sessions_on_start(app: &tauri::AppHandle, state: &SharedState) {
    let path = match sessions_file(app) {
        Ok(p) => p,
        Err(_) => return,
    };
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(list) = serde_json::from_str::<Vec<Session>>(&text) {
            if let Ok(mut g) = state.lock() {
                for mut s in list {
                    // 旧版本把 canonicalize 的结果（带 `\\?\` 前缀）直接存盘，
                    // 这里在载入时统一迁移成普通路径，避免界面上出现 `\\?\D:\...`。
                    s.source_path = platform::strip_verbatim(&s.source_path);
                    s.target_path = platform::strip_verbatim(&s.target_path);
                    g.sessions.insert(s.id.clone(), s);
                }
            }
        }
    }
    // 恢复上次实际使用的会话，而不是按键值排序取第一个（键是时间戳，会取到最旧的）。
    if let Ok(p) = ui_state_file(app) {
        if let Ok(text) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(id) = v.get("lastActiveSession").and_then(|x| x.as_str()) {
                    if let Ok(mut g) = state.lock() {
                        if g.sessions.contains_key(id) {
                            g.active_session = Some(id.to_string());
                        }
                    }
                }
            }
        }
    }
    if let Ok(mut g) = state.lock() {
        if g.active_session.is_none() {
            g.active_session = g.sessions.keys().next().cloned();
        }
    }
}

fn persist_sessions(app: &tauri::AppHandle, state: &SharedState) -> Result<(), String> {
    let path = sessions_file(app)?;
    let (list, active): (Vec<Session>, Option<String>) = {
        let g = state.lock().map_err(|e| e.to_string())?;
        (g.sessions.values().cloned().collect(), g.active_session.clone())
    };
    let text = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("tmp-{}", short_id()));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;

    let ui = ui_state_file(app)?;
    let ui_text = serde_json::to_string_pretty(&json!({ "lastActiveSession": active }))
        .map_err(|e| e.to_string())?;
    let ui_tmp = ui.with_extension(format!("tmp-{}", short_id()));
    std::fs::write(&ui_tmp, ui_text).map_err(|e| e.to_string())?;
    std::fs::rename(&ui_tmp, &ui).map_err(|e| e.to_string())?;
    Ok(())
}

fn get_session(state: &SharedState, id: &str) -> Result<Session, String> {
    let g = state.lock().map_err(|e| e.to_string())?;
    g.sessions
        .get(id)
        .cloned()
        .ok_or_else(|| "会话不存在，请先绑定目录".into())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub product: String,
    pub version: String,
    pub data_dir: String,
    pub platform: String,
}

#[tauri::command]
pub fn app_info(app: tauri::AppHandle) -> Result<AppInfo, String> {
    Ok(AppInfo {
        product: "Easy Compare".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        data_dir: app_data(&app)?.to_string_lossy().to_string(),
        platform: std::env::consts::OS.into(),
    })
}

/// Q8 辅助：列出本机盘符，含卷标、卷标识、类型与可用空间。
#[tauri::command]
pub fn list_drives() -> Result<Vec<DriveInfo>, String> {
    Ok(platform::list_drives())
}

#[tauri::command]
pub fn browse_dirs(path: String) -> Result<Vec<DirInfo>, String> {
    platform::list_directories(&path)
}

#[tauri::command]
pub fn list_sessions(state: State<'_, SharedState>) -> Result<Vec<Session>, String> {
    let g = state.lock().map_err(|e| e.to_string())?;
    Ok(g.sessions.values().cloned().collect())
}

/// 返回上次使用的会话，供前端启动时直接恢复（而不是取排序后的第一个）。
#[tauri::command]
pub fn active_session(state: State<'_, SharedState>) -> Result<Option<Session>, String> {
    let g = state.lock().map_err(|e| e.to_string())?;
    Ok(g.active_session
        .as_ref()
        .and_then(|id| g.sessions.get(id).cloned()))
}

#[tauri::command]
pub fn delete_session(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    id: String,
) -> Result<(), String> {
    {
        let mut g = state.lock().map_err(|e| e.to_string())?;
        g.sessions.remove(&id);
        if g.active_session.as_deref() == Some(id.as_str()) {
            g.active_session = g.sessions.keys().next().cloned();
        }
        g.last_compare = None;
        g.baseline = None;
    }
    persist_sessions(&app, &state)
}

/// 校验并绑定路径（PRD 4.5 第 1 条）。
#[tauri::command]
pub fn validate_and_bind(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    source: String,
    target: String,
    name: String,
    session_id: Option<String>,
) -> Result<BindResult, String> {
    // 用户可能把带 `\\?\` 前缀的路径粘贴回来；先在入口处剥掉，再去访问磁盘。
    let source = platform::strip_verbatim(&source);
    let target = platform::strip_verbatim(&target);
    let sp = PathBuf::from(&source);
    let tp = PathBuf::from(&target);
    let mut r = BindResult::default();

    r.source_exists = sp.is_dir();
    r.source_readable = sp.is_dir() && std::fs::read_dir(&sp).is_ok();
    r.target_exists = tp.is_dir();
    if !r.source_exists {
        r.message = "源目录不存在".into();
        return Ok(r);
    }
    if !r.target_exists {
        r.message = "目标目录不存在".into();
        return Ok(r);
    }
    let src_canon = std::fs::canonicalize(&sp).unwrap_or(sp.clone());
    let tgt_canon = std::fs::canonicalize(&tp).unwrap_or(tp.clone());
    if src_canon == tgt_canon {
        r.message = "源目录与目标目录不能相同".into();
        return Ok(r);
    }
    if tgt_canon.starts_with(&src_canon) {
        r.message = "目标目录不能位于源目录内部，这会造成递归复制".into();
        return Ok(r);
    }
    if src_canon.starts_with(&tgt_canon) {
        r.message = "源目录不能位于目标目录内部，否则备份会把备份结果再备份一次".into();
        return Ok(r);
    }
    r.target_writable = platform::probe_writable(&tp);
    let (_, vol) = platform::volume_identity(&tp);
    r.target_volume = vol.clone();
    r.target_free_bytes = platform::free_space(&tp);
    if !r.target_writable {
        r.message = "目标目录不可写，请检查权限或移动硬盘写保护".into();
        return Ok(r);
    }
    if vol.is_empty() {
        r.message = "无法读取目标卷标识，请确认目标为本地磁盘或移动硬盘".into();
        return Ok(r);
    }

    let now = now_secs();
    let id = session_id.filter(|s| !s.is_empty()).unwrap_or_else(short_id);
    let old = {
        let g = state.lock().map_err(|e| e.to_string())?;
        g.sessions.get(&id).cloned()
    };
    let s = Session {
        id: id.clone(),
        name: if name.trim().is_empty() {
            "笔记本 → 移动硬盘".into()
        } else {
            name.trim().into()
        },
        source_path: platform::display_path(&src_canon),
        target_path: platform::display_path(&tgt_canon),
        target_volume: vol,
        compare_rule: old
            .as_ref()
            .map(|o| o.compare_rule.clone())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "quick".into()),
        filters: old.as_ref().map(|o| o.filters.clone()).unwrap_or_default(),
        last_backup_at: old.as_ref().and_then(|o| o.last_backup_at),
        created_at: old.as_ref().map(|o| o.created_at).unwrap_or(now),
        updated_at: now,
    };
    {
        let mut g = state.lock().map_err(|e| e.to_string())?;
        g.sessions.insert(id.clone(), s.clone());
        g.active_session = Some(id.clone());
        g.baseline = None;
        g.last_compare = None;
    }
    persist_sessions(&app, &state)?;
    r.ok = true;
    r.session = Some(s);
    r.message = "路径与卷标识校验通过".into();
    Ok(r)
}

/// Q8：盘符变化后重绑。只有卷标识一致才自动接受，否则要求用户明确重新绑定。
#[tauri::command]
pub fn rebind_target(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    session_id: String,
    new_target: String,
    force: bool,
) -> Result<BindResult, String> {
    let mut s = get_session(&state, &session_id)?;
    let new_target = platform::strip_verbatim(&new_target);
    let tp = PathBuf::from(&new_target);
    let (_, vol) = platform::volume_identity(&tp);
    if !force && vol != s.target_volume {
        let mut r = BindResult::default();
        r.target_exists = tp.is_dir();
        r.target_volume = vol.clone();
        r.message = format!(
            "卷标识不匹配：原会话 {}，新目录 {}。为避免写入错误的移动硬盘，已拒绝自动重绑。请确认后选择「重新绑定」。",
            s.target_volume, vol
        );
        return Ok(r);
    }
    if !tp.is_dir() {
        let mut r = BindResult::default();
        r.message = "新目标目录不存在".into();
        return Ok(r);
    }
    s.target_path = platform::display_path(&tp);
    s.target_volume = vol.clone();
    s.updated_at = now_secs();
    {
        let mut g = state.lock().map_err(|e| e.to_string())?;
        g.sessions.insert(s.id.clone(), s.clone());
        g.baseline = None;
    }
    persist_sessions(&app, &state)?;
    Ok(BindResult {
        ok: true,
        session: Some(s),
        source_exists: true,
        source_readable: true,
        target_exists: true,
        target_writable: true,
        target_volume: vol,
        target_free_bytes: platform::free_space(&tp),
        message: if force {
            "已按用户确认重新绑定为新卷，基线将重建；本次不自动继承旧冲突判定".into()
        } else {
            "已识别为同一块卷，目标路径更新完成".into()
        },
    })
}

/// 递归扫描 + 比对定态（PRD 4.5 第 2、3 条）。后台执行，进度事件回传，支持取消。
#[tauri::command]
pub async fn compare(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    session_id: String,
    compare_rule: Option<String>,
    filters: Option<Filters>,
) -> Result<CompareResult, String> {
    // 先定位应用数据目录：这一步失败时不应留下 scanning=true 的残留状态。
    let app_data = app_data(&app)?;
    let mut session = get_session(&state, &session_id)?;
    if let Some(rule) = compare_rule {
        session.compare_rule = rule;
    }
    if let Some(f) = filters {
        session.filters = f;
    }
    {
        let mut g = state.lock().map_err(|e| e.to_string())?;
        g.sessions.insert(session.id.clone(), session.clone());
        g.active_session = Some(session.id.clone());
    }

    let cancel = {
        let mut g = state.lock().map_err(|e| e.to_string())?;
        if g.scanning {
            return Err("已有扫描任务在运行，请先等待或取消".into());
        }
        g.scanning = true;
        g.scan_cancel.store(false, Ordering::Relaxed);
        g.scan_cancel.clone()
    };

    let scan_app_data = app_data.clone();
    let src_root = PathBuf::from(&session.source_path);
    let tgt_root = PathBuf::from(&session.target_path);
    let use_hash = session.compare_rule == "hash";
    let volsess = session.clone();
    let session_for_state = session.clone();
    let handle = app.clone();

    let work = tauri::async_runtime::spawn_blocking(move || -> Result<CompareResult, String> {
        let _ = handle.emit("scan-progress", json!({ "phase": "start", "scanned": 0 }));
        let cb = {
            let h = handle.clone();
            let mut last = 0usize;
            move |n: usize, rel: &str| {
                if n >= last + 200 {
                    last = n;
                    let _ = h.emit(
                        "scan-progress",
                        json!({ "phase": "scanning", "scanned": n, "current": rel }),
                    );
                }
            }
        };
        let left = scanner::scan_side(&src_root, &volsess.filters, use_hash, cancel.clone(), cb);
        let cb2 = {
            let h = handle.clone();
            let mut last = 0usize;
            move |n: usize, rel: &str| {
                if n >= last + 200 {
                    last = n;
                    let _ = h.emit(
                        "scan-progress",
                        json!({ "phase": "scanning-target", "scanned": n, "current": rel }),
                    );
                }
            }
        };
        let right = scanner::scan_side(&tgt_root, &volsess.filters, use_hash, cancel.clone(), cb2);
        let _ = handle.emit("scan-progress", json!({ "phase": "comparing" }));

        let bl = backup::load_baseline(
            &tgt_root,
            &scan_app_data,
            &volsess.id,
            &volsess.target_volume,
        );
        let (tree, counts, mut warnings) =
            scanner::compare(&left, &right, bl.baseline.as_ref(), use_hash);

        let aborted = left.aborted || right.aborted;
        if aborted {
            warnings.push(
                "本次扫描被取消或因异常提前结束，比对结果不完整，禁止执行备份；请重新比对"
                    .into(),
            );
        }
        if !bl.warning.is_empty() {
            warnings.push(bl.warning.clone());
        }
        let (vol_ok, vol_msg) = backup::check_volume(&volsess.target_volume, &tgt_root);
        if bl.baseline.is_some() && bl.source == "应用数据目录" {
            warnings.push("基线从应用数据目录恢复（目标盘侧不可读），冲突判定可能不完整".into());
        }
        if left.skipped_links + right.skipped_links > 0 {
            warnings.push(format!(
                "已跳过 {} 个符号链接／目录联接，未参与比对",
                left.skipped_links + right.skipped_links
            ));
        }
        let result = CompareResult {
            session_id: volsess.id.clone(),
            source_path: volsess.source_path.clone(),
            target_path: volsess.target_path.clone(),
            tree,
            counts,
            compared_at: now_secs(),
            has_baseline: bl.baseline.is_some(),
            volume_ok: vol_ok,
            volume_message: vol_msg,
            compare_rule: volsess.compare_rule.clone(),
            warnings,
            scanned_files: left.files.len() + right.files.len(),
            skipped_links: left.skipped_links + right.skipped_links,
            aborted,
        };
        let _ = handle.emit(
            "scan-progress",
            json!({ "phase": "done", "scanned": result.scanned_files }),
        );
        Ok(result)
    })
    .await
    .map_err(|e| format!("扫描任务异常：{}", e));

    // P0：无论扫描成功、失败还是任务 panic，都必须复位 scanning，
    // 否则后续所有比对都会因「已有扫描任务在运行」被永久拒绝。
    let outcome = work.and_then(|r| r);
    if let Ok(mut g) = state.lock() {
        g.scanning = false;
        if let Ok(ref result) = outcome {
            g.last_compare = Some(result.clone());
            g.baseline = backup::load_baseline(
                &PathBuf::from(&session_for_state.target_path),
                &app_data,
                &session_for_state.id,
                &session_for_state.target_volume,
            )
            .baseline;
        }
    }
    let result = outcome?;
    let _ = persist_sessions(&app, &state);
    Ok(result)
}

#[tauri::command]
pub fn cancel_scan(state: State<'_, SharedState>) -> Result<(), String> {
    let g = state.lock().map_err(|e| e.to_string())?;
    g.scan_cancel.store(true, Ordering::Relaxed);
    Ok(())
}

/// 追加内容校验（PRD 4.5 第 4 条，Q2）：只对选中项计算哈希。
/// 追加内容校验（PRD 4.5 第 4 条，Q2）：只对选中项计算哈希。
/// 哈希计算可能耗时数分钟，必须放到阻塞线程池，且不得持有全局状态锁。
#[tauri::command]
pub async fn verify_hashes(
    state: State<'_, SharedState>,
    selected: Vec<String>,
) -> Result<CompareResult, String> {
    let mut result = {
        let g = state.lock().map_err(|e| e.to_string())?;
        g.last_compare
            .clone()
            .ok_or_else(|| "请先执行比对".to_string())?
    };
    let src = PathBuf::from(&result.source_path);
    let tgt = PathBuf::from(&result.target_path);
    let mut tree = std::mem::take(&mut result.tree);

    let (tree, counts, n) = tauri::async_runtime::spawn_blocking(
        move || -> Result<(Vec<TreeNode>, StateCounts, usize), String> {
            let n = scanner::verify_selected(&src, &tgt, &mut tree, &selected)?;
            let counts = scanner::count_states(&tree);
            Ok((tree, counts, n))
        },
    )
    .await
    .map_err(|e| format!("哈希校验任务异常：{}", e))??;

    result.tree = tree;
    result.counts = counts;
    result
        .warnings
        .push(format!("已对 {} 个选中项完成 SHA-256 精确校验", n));
    {
        let mut g = state.lock().map_err(|e| e.to_string())?;
        g.last_compare = Some(result.clone());
    }
    Ok(result)
}

/// 生成预演计划（PRD 4.5 第 5 条）。计划留在 Rust 侧，前端只拿到 id。
#[tauri::command]
pub fn create_plan(
    state: State<'_, SharedState>,
    session_id: String,
    selected: Vec<String>,
    mirror_mode: bool,
    keep_old_versions: bool,
    resolutions: Option<BTreeMap<String, String>>,
) -> Result<Plan, String> {
    let session = get_session(&state, &session_id)?;
    let cmp = {
        let g = state.lock().map_err(|e| e.to_string())?;
        g.last_compare
            .clone()
            .ok_or_else(|| "请先执行比对".to_string())?
    };
    let plan = backup::create_plan(
        &session,
        &cmp,
        &selected,
        mirror_mode,
        keep_old_versions,
        resolutions.unwrap_or_default(),
    );
    {
        let mut g = state.lock().map_err(|e| e.to_string())?;
        g.plans.insert(plan.id.clone(), plan.clone());
    }
    Ok(plan)
}

/// 执行备份（PRD 4.5 第 6 条）。逐项执行、进度回传、单项失败不中断整批。
#[tauri::command]
pub async fn execute_backup(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    plan_id: String,
    confirmed: bool,
) -> Result<BackupResult, String> {
    let plan = {
        let g = state.lock().map_err(|e| e.to_string())?;
        g.plans
            .get(&plan_id)
            .cloned()
            .ok_or_else(|| "预演计划已失效，请重新生成".to_string())?
    };
    // 一次性令牌：计划执行后立即移除，防止重复提交。
    {
        let mut g = state.lock().map_err(|e| e.to_string())?;
        g.plans.remove(&plan_id);
    }
    let session = get_session(&state, &plan.session_id)?;
    let previous_baseline = {
        let g = state.lock().map_err(|e| e.to_string())?;
        g.baseline.clone()
    };
    let app_data = app_data(&app)?;
    let handle = app.clone();
    let plan_clone = plan.clone();
    let sess_clone = session.clone();
    let prev = previous_baseline.clone();
    let data = app_data.clone();

    let result = tauri::async_runtime::spawn_blocking(move || -> Result<BackupResult, String> {
        let mut res = backup::execute_plan(&plan_clone, confirmed, |done, total, rel, status| {
            let _ = handle.emit(
                "backup-progress",
                json!({ "done": done, "total": total, "rel": rel, "status": status }),
            );
        })?;
        // 基线以执行后的源端全量快照重建：既包含本次写入项，也包含本就已同步的项。
        // 部分失败/中途暂停时仍需写入已完成项，否则下次会重复整批复制。
        if res.succeeded > 0 {
            let vol = plan_clone.target_volume.clone();
            let b = backup::rebuild_baseline(prev, &sess_clone, &res, &vol);
            match backup::save_baseline(
                &PathBuf::from(&sess_clone.target_path),
                &data,
                &b,
            ) {
                Ok(_) => res.baseline_updated = true,
                Err(e) => {
                    let prefix = if res.aborted_reason.is_empty() {
                        String::new()
                    } else {
                        format!("{}；", res.aborted_reason)
                    };
                    res.aborted_reason = format!("{}基线写入失败：{}", prefix, e);
                }
            }
        }
        Ok(res)
    })
    .await
    .map_err(|e| format!("备份任务异常：{}", e))??;

    {
        let mut g = state.lock().map_err(|e| e.to_string())?;
        g.last_result = Some(result.clone());
        if let Some(s) = g.sessions.get_mut(&session.id) {
            if result.succeeded > 0 {
                s.last_backup_at = Some(result.finished_at);
                s.updated_at = result.finished_at;
            }
        }
        g.baseline = backup::load_baseline(
            &PathBuf::from(&session.target_path),
            &app_data,
            &session.id,
            &session.target_volume,
        )
        .baseline;
    }
    let _ = persist_sessions(&app, &state);
    Ok(result)
}

/// 刷新并写基线（PRD 4.5 第 7 条）：执行后自动重新比对，返回最新状态树。
#[tauri::command]
pub async fn refresh_after_backup(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    session_id: String,
) -> Result<CompareResult, String> {
    compare(app, state, session_id, None, None).await
}

#[tauri::command]
pub fn export_report(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
) -> Result<String, String> {
    let (result, session) = {
        let g = state.lock().map_err(|e| e.to_string())?;
        let r = g
            .last_result
            .clone()
            .ok_or_else(|| "尚无可导出的执行结果".to_string())?;
        let id = g
            .active_session
            .clone()
            .ok_or_else(|| "会话不存在".to_string())?;
        let s = g
            .sessions
            .get(&id)
            .cloned()
            .ok_or_else(|| "会话不存在".to_string())?;
        (r, s)
    };
    backup::export_report(&app_data(&app)?, &result, &session)
}
