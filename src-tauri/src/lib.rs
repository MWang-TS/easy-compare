//! Easy Compare — 目录差异比对与增量备份桌面客户端。
//! 分层：WebView 前端只负责呈现与交互；全部文件 I/O、状态判定与安全校验在 Rust 核心。

pub mod backup;
pub mod commands;
pub mod model;
pub mod platform;
pub mod scanner;
#[cfg(test)]
mod selftest;

use commands::SharedState;
use tauri::Manager;

pub fn run() {
    let state = SharedState::default();

    tauri::Builder::default()
        .manage(state)
        .setup(|app| {
            let shared = app.state::<SharedState>();
            commands::load_sessions_on_start(app.handle(), &shared);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::list_drives,
            commands::browse_dirs,
            commands::list_sessions,
            commands::active_session,
            commands::delete_session,
            commands::validate_and_bind,
            commands::rebind_target,
            commands::compare,
            commands::cancel_scan,
            commands::verify_hashes,
            commands::create_plan,
            commands::execute_backup,
            commands::refresh_after_backup,
            commands::export_report,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Easy Compare");
}
