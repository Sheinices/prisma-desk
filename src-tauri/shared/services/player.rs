use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

const POTPLAYER_EXE_NAMES: [&str; 3] = [
    "PotPlayerMini64.exe",
    "PotPlayerMini.exe",
    "PotPlayer64.exe",
];

fn is_potplayer_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| {
            POTPLAYER_EXE_NAMES
                .iter()
                .any(|candidate| name.eq_ignore_ascii_case(candidate))
        })
        .unwrap_or(false)
}

fn path_value(path: PathBuf, source: &str) -> Value {
    json!({
        "id": "potplayer",
        "path": path.to_string_lossy().to_string(),
        "source": source,
        "is64BitPreferred": path.file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.eq_ignore_ascii_case("PotPlayerMini64.exe"))
            .unwrap_or(false)
    })
}

#[cfg(target_os = "windows")]
fn registry_candidates() -> Vec<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let mut result = Vec::new();
    let roots = [
        RegKey::predef(HKEY_CURRENT_USER),
        RegKey::predef(HKEY_LOCAL_MACHINE),
    ];
    let subkeys = [
        r"Software\Microsoft\Windows\CurrentVersion\App Paths\PotPlayerMini64.exe",
        r"Software\Microsoft\Windows\CurrentVersion\App Paths\PotPlayerMini.exe",
        r"Software\DAUM\PotPlayer",
        r"Software\PotPlayer",
    ];

    for root in roots {
        for subkey in subkeys {
            let Ok(key) = root.open_subkey_with_flags(subkey, KEY_READ) else {
                continue;
            };

            if let Ok(value) = key.get_value::<String, _>("") {
                let path = PathBuf::from(value.trim_matches('"'));
                if path.exists() && is_potplayer_path(&path) {
                    result.push(path);
                }
            }

            for value_name in ["Path", "ExePath", "InstallPath"] {
                if let Ok(value) = key.get_value::<String, _>(value_name) {
                    let raw = PathBuf::from(value.trim_matches('"'));
                    let path = if raw.is_dir() {
                        raw.join("PotPlayerMini64.exe")
                    } else {
                        raw
                    };
                    if path.exists() && is_potplayer_path(&path) {
                        result.push(path);
                    }
                }
            }
        }
    }

    result
}

#[cfg(not(target_os = "windows"))]
fn registry_candidates() -> Vec<PathBuf> {
    Vec::new()
}

fn filesystem_candidates() -> Vec<PathBuf> {
    #[allow(unused_mut)]
    let mut result = Vec::new();

    #[cfg(target_os = "windows")]
    {
        let program_files = std::env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
        let program_files_x86 = std::env::var_os("ProgramFiles(x86)")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files (x86)"));

        for base in [program_files, program_files_x86] {
            for folder in ["PotPlayer", "DAUM\\PotPlayer"] {
                result.push(base.join(folder).join("PotPlayerMini64.exe"));
                result.push(base.join(folder).join("PotPlayerMini.exe"));
            }
        }
    }

    result
}

fn dedupe_paths(paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for path in paths {
        if !path.exists() || !is_potplayer_path(&path) {
            continue;
        }

        let normalized = path.canonicalize().unwrap_or(path);
        let key = normalized.to_string_lossy().to_ascii_lowercase();
        if seen.insert(key) {
            result.push(normalized);
        }
    }
    result
}

pub fn detect(path_hint: Option<String>) -> Value {
    let mut candidates = Vec::new();
    if let Some(path) = path_hint.map(PathBuf::from) {
        if path.exists() && is_potplayer_path(&path) {
            candidates.push((path, "saved"));
        }
    }

    for path in registry_candidates() {
        candidates.push((path, "registry"));
    }
    for path in filesystem_candidates() {
        candidates.push((path, "filesystem"));
    }

    let paths = dedupe_paths(candidates.iter().map(|(path, _)| path.clone()));
    let entries = paths
        .into_iter()
        .map(|path| {
            let source = candidates
                .iter()
                .find(|(candidate, _)| {
                    candidate
                        .canonicalize()
                        .unwrap_or_else(|_| candidate.clone())
                        == path
                })
                .map(|(_, source)| *source)
                .unwrap_or("filesystem");
            path_value(path, source)
        })
        .collect::<Vec<_>>();

    let preferred = entries
        .iter()
        .find(|entry| entry["is64BitPreferred"].as_bool().unwrap_or(false))
        .or_else(|| entries.first())
        .cloned();

    json!({
        "success": preferred.is_some(),
        "supported": cfg!(target_os = "windows"),
        "player": "potplayer",
        "preferred": preferred,
        "candidates": entries,
        "message": if preferred.is_some() {
            "PotPlayer найден"
        } else if cfg!(target_os = "windows") {
            "PotPlayer не найден"
        } else {
            "Синхронизация PotPlayer доступна только в Windows"
        }
    })
}

pub fn validate(path: String) -> Value {
    let candidate = PathBuf::from(path.trim_matches('"'));
    let valid = cfg!(target_os = "windows") && candidate.is_file() && is_potplayer_path(&candidate);
    json!({
        "success": valid,
        "supported": cfg!(target_os = "windows"),
        "player": "potplayer",
        "path": candidate.to_string_lossy().to_string(),
        "message": if valid {
            "Путь PotPlayer проверен"
        } else if !cfg!(target_os = "windows") {
            "PotPlayer поддерживается только в Windows"
        } else {
            "Укажите существующий PotPlayerMini64.exe или PotPlayerMini.exe"
        }
    })
}

pub fn choose_path() -> Value {
    let Some(path) = rfd::FileDialog::new()
        .set_title("Выберите PotPlayer")
        .add_filter("PotPlayer", &["exe"])
        .pick_file()
    else {
        return json!({ "success": false, "cancelled": true, "message": "Операция отменена" });
    };

    validate(path.to_string_lossy().to_string())
}

pub fn start(path: String, url: String, resume_position_sec: Option<f64>) -> Result<Value, String> {
    let validation = validate(path.clone());
    if !validation["success"].as_bool().unwrap_or(false) {
        return Err(validation["message"]
            .as_str()
            .unwrap_or("Недопустимый путь PotPlayer")
            .to_string());
    }

    let mut command = Command::new(&path);
    command.arg(url);
    command.arg("/new");
    if let Some(position) = resume_position_sec {
        if position.is_finite() && position >= 1.0 {
            command.arg(format!("/seek={position:.3}"));
        }
    }

    let child = command
        .spawn()
        .map_err(|error| format!("Не удалось запустить PotPlayer: {error}"))?;
    let pid = child.id();

    Ok(json!({
        "success": true,
        "player": "potplayer",
        "pid": pid,
        "path": path,
        "resumePositionSec": resume_position_sec.unwrap_or(0.0)
    }))
}

#[cfg(target_os = "windows")]
mod windows_ipc {
    use serde_json::{json, Value};
    use std::mem::MaybeUninit;

    type Hwnd = isize;
    type Lparam = isize;
    type Wparam = usize;
    type Bool = i32;

    const WM_USER: u32 = 0x0400;
    const GET_TOTAL_TIME: Wparam = 0x5002;
    const GET_CURRENT_TIME: Wparam = 0x5004;
    const SET_CURRENT_TIME: Wparam = 0x5005;
    const GET_PLAY_STATUS: Wparam = 0x5006;
    const SMTO_BLOCK: u32 = 0x0001;
    const SMTO_ABORTIFHUNG: u32 = 0x0002;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn EnumWindows(
            callback: Option<unsafe extern "system" fn(Hwnd, Lparam) -> Bool>,
            data: Lparam,
        ) -> Bool;
        fn GetClassNameW(hwnd: Hwnd, class_name: *mut u16, max_count: i32) -> i32;
        fn GetWindowTextW(hwnd: Hwnd, title: *mut u16, max_count: i32) -> i32;
        fn GetWindowThreadProcessId(hwnd: Hwnd, process_id: *mut u32) -> u32;
        fn IsWindow(hwnd: Hwnd) -> Bool;
        fn IsWindowVisible(hwnd: Hwnd) -> Bool;
        fn SendMessageTimeoutW(
            hwnd: Hwnd,
            message: u32,
            wparam: Wparam,
            lparam: Lparam,
            flags: u32,
            timeout: u32,
            result: *mut usize,
        ) -> isize;
    }

    #[derive(Clone)]
    struct WindowInfo {
        hwnd: Hwnd,
        pid: u32,
        class_name: String,
        title: String,
        visible: bool,
    }

    unsafe extern "system" fn collect_window(hwnd: Hwnd, data: Lparam) -> Bool {
        let mut class_buffer = [0u16; 128];
        let class_length = GetClassNameW(hwnd, class_buffer.as_mut_ptr(), class_buffer.len() as i32);
        if class_length <= 0 {
            return 1;
        }

        let class_name = String::from_utf16_lossy(&class_buffer[..class_length as usize]);
        if !class_name.eq_ignore_ascii_case("PotPlayer64")
            && !class_name.eq_ignore_ascii_case("PotPlayer")
        {
            return 1;
        }

        let mut title_buffer = [0u16; 512];
        let title_length = GetWindowTextW(hwnd, title_buffer.as_mut_ptr(), title_buffer.len() as i32);
        let title = if title_length > 0 {
            String::from_utf16_lossy(&title_buffer[..title_length as usize])
        } else {
            String::new()
        };
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        let windows = &mut *(data as *mut Vec<WindowInfo>);
        windows.push(WindowInfo {
            hwnd,
            pid,
            class_name,
            title,
            visible: IsWindowVisible(hwnd) != 0,
        });
        1
    }

    fn windows() -> Vec<WindowInfo> {
        let mut result = Vec::<WindowInfo>::new();
        unsafe {
            EnumWindows(Some(collect_window), &mut result as *mut _ as Lparam);
        }
        result
    }

    fn find_window(candidates: &[WindowInfo], requested_pid: Option<u32>) -> Option<(WindowInfo, bool)> {
        if let Some(pid) = requested_pid {
            if let Some(window) = candidates.iter().find(|window| window.pid == pid) {
                return Some((window.clone(), false));
            }
        }

        candidates
            .iter()
            .find(|window| window.visible)
            .or_else(|| candidates.first())
            .cloned()
            .map(|window| (window, requested_pid.is_some()))
    }

    fn window_json(window: &WindowInfo) -> Value {
        json!({
            "hwnd": format!("0x{:X}", window.hwnd),
            "pid": window.pid,
            "class": window.class_name,
            "title": window.title,
            "visible": window.visible,
        })
    }

    fn query(hwnd: Hwnd, command: Wparam, timeout_ms: u32) -> Option<i64> {
        let mut result = MaybeUninit::<usize>::zeroed();
        let sent = unsafe {
            SendMessageTimeoutW(
                hwnd,
                WM_USER,
                command,
                0,
                SMTO_BLOCK | SMTO_ABORTIFHUNG,
                timeout_ms,
                result.as_mut_ptr(),
            )
        };
        if sent == 0 {
            return None;
        }
        Some(unsafe { result.assume_init() as i64 })
    }

    pub fn read_state(requested_pid: Option<u32>) -> Value {
        let candidates = windows();
        let candidate_json = candidates.iter().map(window_json).collect::<Vec<_>>();
        let Some((window, fallback_used)) = find_window(&candidates, requested_pid) else {
            return json!({
                "success": false,
                "ready": false,
                "reason": "window_not_found",
                "requestedPid": requested_pid,
                "candidates": candidate_json,
            });
        };

        if unsafe { IsWindow(window.hwnd) } == 0 {
            return json!({
                "success": false,
                "ready": false,
                "reason": "window_closed",
                "requestedPid": requested_pid,
                "window": window_json(&window),
                "fallbackUsed": fallback_used,
                "candidates": candidate_json,
            });
        }

        let current_ms = query(window.hwnd, GET_CURRENT_TIME, 700);
        let duration_ms = query(window.hwnd, GET_TOTAL_TIME, 700);
        let status = query(window.hwnd, GET_PLAY_STATUS, 700);
        let reason = if current_ms.is_none() {
            "current_time_timeout"
        } else if duration_ms.is_none() {
            "duration_timeout"
        } else if status.is_none() {
            "status_timeout"
        } else {
            "ok"
        };
        let position_ms = current_ms.map(|value| value.max(0));
        let duration_ms = duration_ms.map(|value| value.max(0));
        let status_value = status.unwrap_or(-1);

        json!({
            "success": current_ms.is_some(),
            "ready": true,
            "reason": reason,
            "requestedPid": requested_pid,
            "windowPid": window.pid,
            "pidMatch": requested_pid.map(|pid| pid == window.pid),
            "fallbackUsed": fallback_used,
            "window": window_json(&window),
            "candidates": candidate_json,
            "messages": {
                "totalTime": { "wParam": "0x5002", "valueMs": duration_ms },
                "currentTime": { "wParam": "0x5004", "valueMs": position_ms },
                "playStatus": { "wParam": "0x5006", "value": status },
            },
            "positionSec": position_ms.map(|value| value as f64 / 1000.0),
            "durationSec": duration_ms.map(|value| value as f64 / 1000.0),
            "status": match status_value {
                2 => "playing",
                1 => "paused",
                _ => "stopped"
            },
            "confidence": "potplayer-wm-user"
        })
    }

    pub fn seek(requested_pid: Option<u32>, position_ms: u64) -> Value {
        let candidates = windows();
        let candidate_json = candidates.iter().map(window_json).collect::<Vec<_>>();
        let Some((window, fallback_used)) = find_window(&candidates, requested_pid) else {
            return json!({
                "success": false,
                "reason": "window_not_found",
                "requestedPid": requested_pid,
                "candidates": candidate_json,
            });
        };
        let position = position_ms.min(isize::MAX as u64) as Lparam;
        let mut result = MaybeUninit::<usize>::zeroed();
        let sent = unsafe {
            SendMessageTimeoutW(
                window.hwnd,
                WM_USER,
                SET_CURRENT_TIME,
                position,
                SMTO_BLOCK | SMTO_ABORTIFHUNG,
                700,
                result.as_mut_ptr(),
            )
        } != 0;
        json!({
            "success": sent,
            "reason": if sent { "ok" } else { "ipc_timeout" },
            "requestedPid": requested_pid,
            "windowPid": window.pid,
            "fallbackUsed": fallback_used,
            "positionMs": position_ms,
            "window": window_json(&window),
            "candidates": candidate_json,
        })
    }
}

#[cfg(not(target_os = "windows"))]
mod windows_ipc {
    use serde_json::{json, Value};

    pub fn read_state(pid: Option<u32>) -> Value {
        json!({
            "success": false,
            "ready": false,
            "supported": false,
            "reason": "windows_only",
            "pid": pid
        })
    }

    pub fn seek(pid: Option<u32>, position_ms: u64) -> Value {
        json!({
            "success": false,
            "supported": false,
            "reason": "windows_only",
            "pid": pid,
            "positionMs": position_ms
        })
    }
}

pub fn read_state(pid: Option<u32>) -> Value {
    windows_ipc::read_state(pid)
}

pub fn seek(pid: Option<u32>, position_ms: u64) -> Value {
    windows_ipc::seek(pid, position_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_supported_potplayer_names_case_insensitively() {
        assert!(is_potplayer_path(Path::new("PotPlayerMini64.exe")));
        assert!(is_potplayer_path(Path::new("PotPlayerMini.exe")));
        assert!(!is_potplayer_path(Path::new("vlc.exe")));
    }

    #[test]
    fn non_windows_detection_is_safe() {
        let result = detect(None);
        assert_eq!(result["player"], "potplayer");
        assert_eq!(result["supported"], cfg!(target_os = "windows"));
    }
}
