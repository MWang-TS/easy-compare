//! 数据结构定义。字段命名与 PRD v1.0 第 4 节一致，序列化统一 camelCase。
//! 注意：以下均为设计约定落成的代码结构，不是对外部事实的断言。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 六态差异状态。判定顺序见 core.rs::classify。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryState {
    Conflict,
    Left,
    Right,
    Diff,
    Ok,
    Unknown,
}

impl EntryState {
    pub fn as_str(self) -> &'static str {
        match self {
            EntryState::Conflict => "conflict",
            EntryState::Left => "left",
            EntryState::Right => "right",
            EntryState::Diff => "diff",
            EntryState::Ok => "ok",
            EntryState::Unknown => "unknown",
        }
    }
    pub fn from_str(s: &str) -> Self {
        match s {
            "conflict" => EntryState::Conflict,
            "left" => EntryState::Left,
            "right" => EntryState::Right,
            "diff" => EntryState::Diff,
            "ok" => EntryState::Ok,
            _ => EntryState::Unknown,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            EntryState::Conflict => "冲突",
            EntryState::Left => "仅源有",
            EntryState::Right => "仅目标有",
            EntryState::Diff => "需更新",
            EntryState::Ok => "已同步",
            EntryState::Unknown => "未比对",
        }
    }
    /// 中间列符号，Q4 要求三重编码中的符号位。
    pub fn symbol(self) -> &'static str {
        match self {
            EntryState::Conflict => "!",
            EntryState::Left => "→",
            EntryState::Right => "←",
            EntryState::Diff => "≠",
            EntryState::Ok => "=",
            EntryState::Unknown => "·",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Filters {
    /// 排除的扩展名（不含点，大小写不敏感）
    #[serde(default)]
    pub exclude_ext: Vec<String>,
    /// 排除的通配符，支持 * 与 ?
    #[serde(default)]
    pub exclude_patterns: Vec<String>,
    /// 排除的目录名（精确匹配，大小写不敏感）
    #[serde(default)]
    pub exclude_dirs: Vec<String>,
}

impl Filters {
    /// 客户端内部数据目录，任何情况下都不参与比对与备份。
    pub const RESERVED_DIRS: &'static [&'static str] = &[".easy-compare"];
    pub fn is_dir_excluded(&self, name: &str) -> bool {
        let n = name.to_ascii_lowercase();
        Self::RESERVED_DIRS.iter().any(|d| n == *d)
            || self.exclude_dirs.iter().any(|d| d.to_ascii_lowercase() == n)
    }
    pub fn is_file_excluded(&self, name: &str) -> bool {
        let n = name.to_ascii_lowercase();
        if let Some(ext) = n.rsplit_once('.').map(|(_, e)| e.to_string()) {
            if self.exclude_ext.iter().any(|e| e.to_ascii_lowercase() == ext) {
                return true;
            }
        }
        self.exclude_patterns
            .iter()
            .any(|p| glob_match(&p.to_ascii_lowercase(), &n))
    }
}

/// 极简通配符匹配，仅支持 * 与 ?，使用动态规划避免正则依赖。
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let mut dp = vec![false; t.len() + 1];
    dp[0] = true;
    for pc in &p {
        let mut next = vec![false; t.len() + 1];
        if *pc == '*' {
            next[0] = dp[0];
            for j in 1..=t.len() {
                next[j] = dp[j] || next[j - 1];
            }
        } else {
            for j in 1..=t.len() {
                next[j] = dp[j - 1] && (*pc == '?' || *pc == t[j - 1]);
            }
        }
        dp = next;
    }
    dp[t.len()]
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub name: String,
    pub source_path: String,
    pub target_path: String,
    /// Q8：目标卷标识（卷序列号 + 卷标），盘符变化时用于识别同一卷。
    pub target_volume: String,
    #[serde(default)]
    pub compare_rule: String, // "quick" | "hash"
    #[serde(default)]
    pub filters: Filters,
    pub last_backup_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 扫描得到的单侧文件元数据。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub size: u64,
    /// UNIX 秒，来自 modified()。跨文件系统精度差异见 README 已知限制。
    pub mtime: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Baseline {
    pub session_id: String,
    pub generated_at: i64,
    pub volume_id: String,
    /// rel_path(小写对齐键) -> 上次成功备份后的文件元数据
    pub entries: BTreeMap<String, FileMeta>,
}

/// 前端双栏树节点。字段刻意贴近高保真原型，便于直接渲染。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub id: String,
    pub rel: String,
    pub name: String,
    pub kind: String, // "dir" | "file"
    pub state: String,
    pub l: String,
    pub r: String,
    pub lb: u64,
    pub rb: u64,
    pub lt: String,
    pub rt: String,
    /// "source" | "target" | ""
    pub nw: String,
    pub err: String,
    pub has_l: bool,
    pub has_r: bool,
    #[serde(default)]
    pub children: Vec<TreeNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StateCounts {
    pub ok: usize,
    pub diff: usize,
    pub left: usize,
    pub right: usize,
    pub conflict: usize,
    pub unknown: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompareResult {
    pub session_id: String,
    pub source_path: String,
    pub target_path: String,
    pub tree: Vec<TreeNode>,
    pub counts: StateCounts,
    pub compared_at: i64,
    /// 是否加载到了有效基线；false 时仅按方向规则降级处理，不在界面弹提示。
    pub has_baseline: bool,
    pub volume_ok: bool,
    pub volume_message: String,
    pub compare_rule: String,
    pub warnings: Vec<String>,
    pub scanned_files: usize,
    pub skipped_links: usize,
    /// 扫描是否被取消或因异常提前结束。true 时结果不完整，必须禁止据此执行备份。
    #[serde(default)]
    pub aborted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub rel: String,
    pub size: u64,
    pub action: String, // add | overwrite | delete
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub session_id: String,
    pub created_at: i64,
    pub to_add: Vec<PlanItem>,
    pub to_overwrite: Vec<PlanItem>,
    pub to_delete: Vec<PlanItem>,
    pub to_skip: Vec<String>,
    pub conflicts: Vec<String>,
    pub total_bytes: u64,
    pub target_free_bytes: u64,
    pub space_ok: bool,
    pub keep_old_versions: bool,
    pub mirror_mode: bool,
    pub volume_ok: bool,
    /// 执行前必须逐项处置完冲突，否则为 false。
    pub executable: bool,
    pub message: String,
    #[serde(skip)]
    pub source_path: String,
    #[serde(skip)]
    pub target_path: String,
    #[serde(skip)]
    pub target_volume: String,
    /// 冲突的人工处置：rel -> "overwrite" | "keep" | "skip"
    #[serde(skip)]
    pub resolutions: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ItemResult {
    pub rel: String,
    pub action: String,
    pub outcome: String, // succeeded | failed | skipped
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub plan_id: String,
    pub per_item: Vec<ItemResult>,
    pub succeeded: usize,
    pub failed: usize,
    pub skipped: usize,
    pub finished_at: i64,
    pub baseline_updated: bool,
    pub aborted_reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    pub root: String,
    pub label: String,
    pub volume_id: String,
    pub drive_type: String,
    pub free_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DirInfo {
    pub name: String,
    pub path: String,
    pub has_children: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BindResult {
    pub ok: bool,
    pub session: Option<Session>,
    pub source_exists: bool,
    pub source_readable: bool,
    pub target_exists: bool,
    pub target_writable: bool,
    pub target_volume: String,
    pub target_free_bytes: u64,
    pub message: String,
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn short_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", n)
}

pub fn fmt_size(b: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    let f = b as f64;
    if f >= GB {
        format!("{:.1} GB", f / GB)
    } else if f >= MB {
        format!("{:.1} MB", f / MB)
    } else if f >= KB {
        format!("{:.0} KB", f / KB)
    } else {
        format!("{} B", b)
    }
}
