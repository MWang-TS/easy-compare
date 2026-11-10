//! Windows 平台适配层。
//! Q8 的卷标识、Q2 的容量预检、目录浏览都在这里落地。
//! 使用 Win32 API 而非第三方 crate，避免额外依赖与 MSRV 冲突。

use crate::model::{DirInfo, DriveInfo};
use std::path::{Path, PathBuf};

#[cfg(windows)]
mod win {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetVolumeInformationW(
            root: *const u16,
            name_buf: *mut u16,
            name_len: u32,
            serial: *mut u32,
            max_component: *mut u32,
            flags: *mut u32,
            fs_buf: *mut u16,
            fs_len: u32,
        ) -> i32;
        fn GetDiskFreeSpaceExW(
            dir: *const u16,
            free_available: *mut u64,
            total: *mut u64,
            total_free: *mut u64,
        ) -> i32;
        fn GetLogicalDrives() -> u32;
        fn GetDriveTypeW(root: *const u16) -> u32;
    }

    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    pub fn wide(s: &OsStr) -> Vec<u16> {
        let mut v: Vec<u16> = s.encode_wide().collect();
        v.push(0);
        v
    }

    pub fn volume_info(root: &OsStr) -> Option<(String, String, String)> {
        let r = wide(root);
        let mut name = vec![0u16; 261];
        let mut serial: u32 = 0;
        let mut max_component: u32 = 0;
        let mut flags: u32 = 0;
        let mut fs = vec![0u16; 261];
        let ok = unsafe {
            GetVolumeInformationW(
                r.as_ptr(),
                name.as_mut_ptr(),
                261,
                &mut serial,
                &mut max_component,
                &mut flags,
                fs.as_mut_ptr(),
                261,
            )
        };
        if ok == 0 {
            return None;
        }
        let label = String::from_utf16_lossy(&name)
            .trim_end_matches('\0')
            .to_string();
        let fs_name = String::from_utf16_lossy(&fs)
            .trim_end_matches('\0')
            .to_string();
        // 卷序列号按 Windows 资源管理器的习惯写成 XXXX-XXXX。
        let id = format!("{:04X}-{:04X}", serial >> 16, serial & 0xFFFF);
        Some((id, label, fs_name))
    }

    pub fn disk_space(dir: &OsStr) -> (u64, u64) {
        let p = wide(dir);
        let mut free: u64 = 0;
        let mut total: u64 = 0;
        let mut total_free: u64 = 0;
        let ok = unsafe {
            GetDiskFreeSpaceExW(p.as_ptr(), &mut free, &mut total, &mut total_free)
        };
        if ok == 0 {
            (0, 0)
        } else {
            (free, total)
        }
    }

    pub fn logical_drives() -> Vec<String> {
        let mask = unsafe { GetLogicalDrives() };
        let mut out = Vec::new();
        for i in 0..26u32 {
            if mask & (1 << i) != 0 {
                let letter = (b'A' + i as u8) as char;
                out.push(format!("{}:\\", letter));
            }
        }
        out
    }

    pub fn drive_type(root: &OsStr) -> String {
        let t = unsafe { GetDriveTypeW(wide(root).as_ptr()) };
        match t {
            2 => "可移动磁盘".into(),
            3 => "本地磁盘".into(),
            4 => "网络驱动器".into(),
            5 => "光驱".into(),
            6 => "RAM 盘".into(),
            0 => "未知".into(),
            1 => "无效".into(),
            _ => "其他".into(),
        }
    }
}

#[cfg(not(windows))]
mod win {
    use std::ffi::OsStr;
    pub fn volume_info(_: &OsStr) -> Option<(String, String, String)> {
        Some(("NON-WINDOWS".into(), String::new(), String::new()))
    }
    pub fn disk_space(_: &OsStr) -> (u64, u64) {
        (u64::MAX, u64::MAX)
    }
    pub fn logical_drives() -> Vec<String> {
        vec!["/".into()]
    }
    pub fn drive_type(_: &OsStr) -> String {
        "本地磁盘".into()
    }
}

/// 从任意路径提取卷根（Windows 为 "E:\"，UNC 保持 "\\server\share\"）。
pub fn volume_root(path: &Path) -> PathBuf {
    let s = path.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        if s.starts_with("\\\\") {
            // UNC: \\server\share\rest
            let parts: Vec<&str> = s.trim_start_matches('\\').split('\\').collect();
            if parts.len() >= 2 {
                return PathBuf::from(format!("\\\\{}\\{}\\", parts[0], parts[1]));
            }
            return PathBuf::from(s);
        }
        let chars: Vec<char> = s.chars().collect();
        if chars.len() >= 3 && chars[1] == ':' && chars[2] == '\\' {
            return PathBuf::from(format!("{}{}\\" , chars[0], chars[1]));
        }
        if chars.len() == 3 && chars[1] == ':' {
            return PathBuf::from(format!("{}{}\\", chars[0], chars[1]));
        }
    }
    // 其它情况：找到第一个存在的祖先
    let mut p = path.to_path_buf();
    while p.parent().is_some() {
        p = p.parent().unwrap().to_path_buf();
        if p.exists() {
            return p;
        }
    }
    path.to_path_buf()
}

/// 去掉 Windows 扩展长度路径前缀（`\\?\`、`\\?\UNC\`、`//?/`），用于展示与持久化。
/// `std::fs::canonicalize` 在 Windows 上会返回 verbatim 路径，直接显示给用户会变成
/// 形如 `\\?\D:\data` 的怪东西；std 的读写 API 在使用时仍会自动按需加回前缀，
/// 因此存成普通路径既不影响长路径支持，也不会把前缀带到界面上。
pub fn strip_verbatim(s: &str) -> String {
    // 兼容反斜杠与正斜杠两种写法
    let t = s.replace('/', "\\");
    if let Some(rest) = t.strip_prefix("\\\\?\\UNC\\") {
        return format!("\\\\{}", rest);
    }
    if let Some(rest) = t.strip_prefix("\\\\?\\") {
        return rest.to_string();
    }
    if let Some(rest) = t.strip_prefix("\\\\.\\") {
        return rest.to_string();
    }
    // 没有前缀时保持原样（不动分隔符，避免把 UNC 或已规范的路径改坏）
    s.to_string()
}

/// 规范化后的可展示路径：优先 canonicalize（解析符号链接），再去掉 verbatim 前缀。
pub fn display_path(p: &Path) -> String {
    let canon = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    strip_verbatim(&canon.to_string_lossy())
}

/// 卷标识 + 卷标组合。盘符变化但同一物理卷时该值保持不变。
pub fn volume_identity(path: &Path) -> (String, String) {
    let root = volume_root(path);
    match win::volume_info(root.as_os_str()) {
        Some((id, label, _fs)) => {
            let combined = if label.is_empty() {
                id.clone()
            } else {
                format!("{}|{}", id, label)
            };
            (id, combined)
        }
        None => (String::new(), String::new()),
    }
}

pub fn free_space(path: &Path) -> u64 {
    win::disk_space(volume_root(path).as_os_str()).0
}

pub fn list_drives() -> Vec<DriveInfo> {
    win::logical_drives()
        .into_iter()
        .filter_map(|root| {
            let p = PathBuf::from(&root);
            let (id, label, _fs) = win::volume_info(p.as_os_str())?;
            let (free, total) = win::disk_space(p.as_os_str());
            Some(DriveInfo {
                label: if label.is_empty() {
                    win::drive_type(p.as_os_str())
                } else {
                    label
                },
                volume_id: id,
                drive_type: win::drive_type(p.as_os_str()),
                free_bytes: free,
                total_bytes: total,
                root,
            })
        })
        .collect()
}

/// 目录浏览：返回子目录，跳过符号链接/目录联接以避免递归成环。
pub fn list_directories(path: &str) -> Result<Vec<DirInfo>, String> {
    let p = PathBuf::from(path);
    if !p.is_dir() {
        return Err(format!("不是有效目录：{}", path));
    }
    let mut out = Vec::new();
    let rd = std::fs::read_dir(&p).map_err(|e| format!("无法读取目录：{}", e))?;
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().to_string();
        let md = match ent.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !md.is_dir() {
            continue;
        }
        if let Ok(sym) = std::fs::symlink_metadata(ent.path()) {
            if sym.file_type().is_symlink() {
                continue;
            }
        }
        if name.to_ascii_lowercase() == ".easy-compare" {
            continue;
        }
        let child_path = ent.path();
        let has_children = std::fs::read_dir(&child_path)
            .map(|it| {
                it.flatten().any(|e| {
                    e.path().is_dir()
                        && std::fs::symlink_metadata(e.path())
                            .map(|m| !m.file_type().is_symlink())
                            .unwrap_or(false)
                })
            })
            .unwrap_or(false);
        out.push(DirInfo {
            name,
            path: child_path.to_string_lossy().to_string(),
            has_children,
        });
    }
    out.sort_by(|a, b| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()));
    Ok(out)
}

/// 写探测：创建一个临时文件后立即删除。不写入用户数据。
pub fn probe_writable(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let probe = dir.join(format!(".ec_probe_{}.tmp", crate::model::short_id()));
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 复制后保持修改时间，否则下一次快速比对会反复判定为差异。
/// 使用标准库 FileTimes（Rust 1.75+），无需额外依赖。
pub fn set_mtime(path: &Path, unix_secs: i64) -> std::io::Result<()> {
    use std::fs::{File, FileTimes};
    use std::time::{Duration, UNIX_EPOCH};
    let t = if unix_secs >= 0 {
        UNIX_EPOCH + Duration::from_secs(unix_secs as u64)
    } else {
        UNIX_EPOCH - Duration::from_secs((-unix_secs) as u64)
    };
    let f = File::options().write(true).open(path)?;
    f.set_times(FileTimes::new().set_modified(t))
}

/// 规范化相对路径：统一使用 / 分隔符，禁止越界。
pub fn safe_rel(rel: &str) -> Option<String> {
    let s = rel.replace('\\', "/");
    if s.is_empty() || s.starts_with('/') || s.contains(':') {
        return None;
    }
    for part in s.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return None;
        }
    }
    Some(s)
}

/// 把相对路径安全地拼到根目录之下，并校验最终路径没有逃逸。
pub fn join_under(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let clean = safe_rel(rel).ok_or_else(|| format!("非法相对路径：{}", rel))?;
    let mut p = root.to_path_buf();
    for part in clean.split('/') {
        p.push(part);
    }
    Ok(p)
}
