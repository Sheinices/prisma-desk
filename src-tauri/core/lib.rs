use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::fs;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, WindowEvent};

mod proxy;
mod store;
mod torrserver;

const BRIDGE_JS: &str = include_str!("../module/bridge.js");
const PLUGIN_JS: &str = include_str!("../module/client-inject.js");
const DEFAULT_PRISMA_URL: &str = "http://prisma.ws";

#[derive(Clone)]
struct AppState {
    store: Arc<Mutex<store::AppStore>>,
    torrserver: Arc<Mutex<torrserver::TorrServerManager>>,
    proxy: Arc<Mutex<proxy::ProxyServerManager>>,
    autostart_done: Arc<Mutex<bool>>,
}

#[derive(Debug, Serialize)]
struct CommandResult {
    success: bool,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChildProcessSpawnRequest {
    id: String,
    cmd: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
}

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;

    Ok(base.join("store.json"))
}

fn get_store_value(state: &tauri::State<'_, AppState>, key: &str) -> Option<Value> {
    let store = state.store.lock().expect("store poisoned");
    store.get(key)
}

fn sanitize_prisma_url(url: &str) -> String {
    let trimmed = url.trim();

    if trimmed.is_empty() {
        return DEFAULT_PRISMA_URL.to_string();
    }

    #[cfg(not(debug_assertions))]
    {
        let lowered = trimmed.to_ascii_lowercase();
        if lowered.contains("localhost:3000") || lowered.contains("127.0.0.1:3000") {
            return DEFAULT_PRISMA_URL.to_string();
        }
    }

    trimmed.to_string()
}

fn is_whitelisted_command(cmd: &str, resolved: &str) -> bool {
    let commands: HashSet<&'static str> = HashSet::from([
        "vlc",
        "kmplayer",
        "kmplayer64",
        "potplayer",
        "potplayermini",
        "potplayermini64",
        "mpv",
        "smplayer",
        "kodi",
        "gom",
        "gom64",
        "mpc-hc",
        "mpc-hc64",
        "mpc-be",
        "mpc-be64",
        "quicktime player",
        "wmplayer",
        "iina",
        "elmedia player",
        "movist",
        "infuse",
        "celluloid",
        "haruna",
        "dragon",
        "parole",
        "5kplayer",
        "zplayer",
    ]);

    let cmd_name = std::path::Path::new(cmd)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_lowercase();

    if commands.contains(cmd_name.as_str()) {
        return true;
    }

    let resolved_name = std::path::Path::new(resolved)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_lowercase();

    commands.contains(resolved_name.as_str())
}

#[tauri::command]
fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn store_get(key: String, state: tauri::State<'_, AppState>) -> Option<Value> {
    let store = state.store.lock().expect("store poisoned");
    store.get(&key)
}

#[tauri::command]
fn store_set(
    app: tauri::AppHandle,
    key: String,
    value: Value,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    {
        let mut store = state.store.lock().expect("store poisoned");
        store.set(key.clone(), value)?;
    }

    if key == "prismaUrl" {
        if let Some(Value::String(url)) = get_store_value(&state, "prismaUrl") {
            let sanitized = sanitize_prisma_url(&url);

            if sanitized != url {
                let mut store = state.store.lock().expect("store poisoned");
                let _ = store.set("prismaUrl".into(), Value::String(sanitized.clone()));
            }

            if let Some(window) = app.get_webview_window("main") {
                let script = format!(
                    "window.location.href = {}",
                    serde_json::to_string(&sanitized)
                        .unwrap_or_else(|_| "\"http://prisma.ws\"".into())
                );
                let _ = window.eval(&script);
            }
        }
    }

    Ok(true)
}

#[tauri::command]
fn store_has(key: String, state: tauri::State<'_, AppState>) -> bool {
    let store = state.store.lock().expect("store poisoned");
    store.has(&key)
}

#[tauri::command]
fn store_delete(key: String, state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let mut store = state.store.lock().expect("store poisoned");
    store.delete(&key)
}

#[tauri::command]
fn store_all(state: tauri::State<'_, AppState>) -> Value {
    let store = state.store.lock().expect("store poisoned");
    store.snapshot()
}

#[tauri::command]
fn toggle_fullscreen(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let current = window
        .is_fullscreen()
        .map_err(|e| format!("failed to read fullscreen state: {e}"))?;

    window
        .set_fullscreen(!current)
        .map_err(|e| format!("failed to toggle fullscreen: {e}"))?;

    let mut store = state.store.lock().expect("store poisoned");
    store.set("fullscreen".into(), Value::Bool(!current))
}

#[tauri::command]
fn close_app(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut torr = state.torrserver.lock().expect("torrserver poisoned");
        let _ = torr.stop(&app);
    }

    {
        let mut proxy = state.proxy.lock().expect("proxy poisoned");
        proxy.stop();
    }

    window
        .close()
        .map_err(|e| format!("failed to close window: {e}"))
}

#[tauri::command]
fn load_url(window: tauri::WebviewWindow, url: String) -> Result<(), String> {
    let script = format!(
        "window.location.href = {}",
        serde_json::to_string(&url).map_err(|e| format!("invalid url payload: {e}"))?
    );

    window
        .eval(&script)
        .map_err(|e| format!("failed to navigate: {e}"))
}

#[tauri::command]
fn fs_exists_sync(path: String) -> bool {
    which::which(path).is_ok()
}

#[cfg(target_os = "macos")]
fn macos_player_app_name(cmd: &str) -> Option<&'static str> {
    let normalized = std::path::Path::new(cmd)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(cmd)
        .to_lowercase();

    match normalized.as_str() {
        "vlc" => Some("VLC"),
        "iina" => Some("IINA"),
        "infuse" => Some("Infuse"),
        "nplayer" => Some("nPlayer"),
        "tracyplayer" => Some("TracyPlayer"),
        "quicktime player" | "quicktimeplayer" => Some("QuickTime Player"),
        "movist" => Some("Movist"),
        "elmedia player" | "elmediaplayer" => Some("Elmedia Player"),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn spawn_macos_app(
    app: tauri::AppHandle,
    req: &ChildProcessSpawnRequest,
    app_name: &str,
) -> Result<bool, String> {
    let mut cmd = Command::new("/usr/bin/open");
    cmd.arg("-a").arg(app_name);

    if !req.args.is_empty() {
        cmd.arg("--args");
        cmd.args(&req.args);
    }

    if let Some(cwd) = req.cwd.as_deref() {
        cmd.current_dir(cwd);
    }

    if let Some(env) = &req.env {
        cmd.envs(env);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn macOS app '{app_name}': {e}"))?;

    let id_exit = req.id.clone();
    let app_for_thread = app.clone();
    std::thread::spawn(move || match child.wait() {
        Ok(status) => {
            let code = status.code().unwrap_or_default();
            let _ = app_for_thread.emit(format!("child-process-spawn-exit-{id_exit}").as_str(), code);
        }
        Err(err) => {
            let _ = app_for_thread.emit(
                format!("child-process-spawn-error-{id_exit}").as_str(),
                err.to_string(),
            );
        }
    });

    Ok(true)
}

fn resolve_spawn_command(cmd: &str) -> Result<PathBuf, String> {
    let path_candidate = PathBuf::from(cmd);

    if cmd.contains(std::path::MAIN_SEPARATOR) || path_candidate.is_absolute() || cmd.starts_with("./") || cmd.starts_with("../") {
        if path_candidate.exists() {
            return Ok(path_candidate);
        }
        return Err(format!("command path does not exist: {cmd}"));
    }

    which::which(cmd).map_err(|e| format!("command not found or not allowed: {e}"))
}

#[tauri::command]
fn child_process_spawn(
    app: tauri::AppHandle,
    req: ChildProcessSpawnRequest,
) -> Result<bool, String> {
    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut cmd_sanitized = req
        .cmd
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_string();

    #[cfg(target_os = "windows")]
    {
        if cmd_sanitized.len() >= 3 {
            let bytes = cmd_sanitized.as_bytes();
            let is_drive_path = bytes[1] == b':';
            if is_drive_path && cmd_sanitized.contains("\\\\") {
                cmd_sanitized = cmd_sanitized.replace("\\\\", "\\");
            }
        }
    }

    #[cfg(target_os = "macos")]
    if let Some(app_name) = macos_player_app_name(&cmd_sanitized) {
        return spawn_macos_app(app, &req, app_name);
    }

    let resolved = resolve_spawn_command(&cmd_sanitized)?;

    let resolved_s = resolved.to_string_lossy().to_string();
    if !is_whitelisted_command(&cmd_sanitized, &resolved_s) {
        return Err(format!(
            "command \"{}\" (resolved to \"{}\") is not allowed by whitelist",
            cmd_sanitized, resolved_s
        ));
    }

    let mut cmd = Command::new(&resolved);
    cmd.args(&req.args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(cwd) = req.cwd.as_deref() {
        cmd.current_dir(cwd);
    }

    if let Some(env) = &req.env {
        cmd.envs(env);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn command: {e}"))?;

    let id_out = req.id.clone();
    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                let _ = app_clone.emit(format!("child-process-spawn-stdout-{id_out}").as_str(), line);
            }
        });
    }

    let id_err = req.id.clone();
    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let _ = app_clone.emit(format!("child-process-spawn-stderr-{id_err}").as_str(), line);
            }
        });
    }

    let id_exit = req.id;
    std::thread::spawn(move || match child.wait() {
        Ok(status) => {
            let code = status.code().unwrap_or_default();
            let _ = app.emit(format!("child-process-spawn-exit-{id_exit}").as_str(), code);
        }
        Err(err) => {
            let _ = app.emit(
                format!("child-process-spawn-error-{id_exit}").as_str(),
                err.to_string(),
            );
        }
    });

    Ok(true)
}
#[tauri::command]
fn open_folder(path: String) -> CommandResult {
    match tauri_plugin_opener::open_path(path, None::<&str>) {
        Ok(_) => CommandResult {
            success: true,
            message: None,
        },
        Err(err) => CommandResult {
            success: false,
            message: Some(err.to_string()),
        },
    }
}

#[tauri::command]
fn open_external_url(url: String) -> CommandResult {
    match tauri_plugin_opener::open_url(url, None::<&str>) {
        Ok(_) => CommandResult {
            success: true,
            message: None,
        },
        Err(err) => CommandResult {
            success: false,
            message: Some(err.to_string()),
        },
    }
}

fn detect_vlc_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let program_files = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
        let program_files_x86 = std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| r"C:\Program Files (x86)".into());

        let candidates = [
            std::path::Path::new(&program_files).join("VideoLAN").join("VLC").join("vlc.exe"),
            std::path::Path::new(&program_files_x86).join("VideoLAN").join("VLC").join("vlc.exe"),
            PathBuf::from(r"C:\Program Files\VideoLAN\VLC\vlc.exe"),
            PathBuf::from(r"C:\Program Files (x86)\VideoLAN\VLC\vlc.exe"),
        ];

        for p in candidates {
            if p.exists() {
                return Some(p);
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let p = PathBuf::from("/Applications/VLC.app/Contents/MacOS/VLC");
        if p.exists() {
            return Some(p);
        }
    }

    #[cfg(target_os = "linux")]
    {
        for p in ["/usr/bin/vlc", "/usr/local/bin/vlc", "/snap/bin/vlc"] {
            let path = PathBuf::from(p);
            if path.exists() {
                return Some(path);
            }
        }
    }

    None
}

#[tauri::command]
fn find_player() -> Value {
    if let Some(path) = detect_vlc_path() {
        return json!({
            "success": true,
            "message": "Найден плеер VLC и установлен как основной",
            "path": path.to_string_lossy()
        });
    }

    json!({"success": false, "message": "Плеер не найден."})
}

#[tauri::command]
fn export_settings_to_file(settings: Value) -> Value {
    let Some(path) = rfd::FileDialog::new()
        .set_title("Экспортировать настройки")
        .set_file_name("prisma-desktop-settings.json")
        .add_filter("JSON файлы", &["json"])
        .save_file()
    else {
        return json!({"success": false, "message": "Операция отменена"});
    };

    match serde_json::to_string_pretty(&settings) {
        Ok(serialized) => match fs::write(&path, serialized) {
            Ok(_) => json!({"success": true, "message": "Настройки успешно экспортированы"}),
            Err(err) => json!({"success": false, "message": format!("Не удалось экспортировать настройки: {err}")}),
        },
        Err(err) => json!({"success": false, "message": format!("Не удалось сериализовать настройки: {err}")}),
    }
}

#[tauri::command]
fn import_settings_from_file() -> Value {
    let Some(path) = rfd::FileDialog::new()
        .set_title("Импортировать настройки")
        .add_filter("JSON файлы", &["json"])
        .pick_file()
    else {
        return json!({"success": false, "message": "Операция отменена"});
    };

    let data = match fs::read_to_string(path) {
        Ok(v) => v,
        Err(err) => {
            return json!({"success": false, "message": format!("Не удалось прочитать файл: {err}")});
        }
    };

    match serde_json::from_str::<Value>(&data) {
        Ok(settings) => json!({"success": true, "settings": settings}),
        Err(err) => json!({"success": false, "message": format!("Неверный формат файла: {err}")}),
    }
}

#[tauri::command]
async fn torrserver_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    args: Option<Vec<String>>,
) -> Result<Value, String> {
    let store = state.store.clone();
    let torr = state.torrserver.clone();
    let args = args.unwrap_or_default();

    match tauri::async_runtime::spawn_blocking(move || {
        let mut torr = torr.lock().expect("torrserver poisoned");
        torr.start(&app, &store, args)
    })
    .await
    {
        Ok(v) => Ok(v),
        Err(err) => Ok(json!({ "success": false, "message": format!("Join error: {err}") })),
    }
}

#[tauri::command]
async fn torrserver_stop(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let torr = state.torrserver.clone();

    match tauri::async_runtime::spawn_blocking(move || {
        let mut torr = torr.lock().expect("torrserver poisoned");
        torr.stop(&app)
    })
    .await
    {
        Ok(v) => Ok(v),
        Err(err) => Ok(json!({ "success": false, "message": format!("Join error: {err}") })),
    }
}

#[tauri::command]
async fn torrserver_restart(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    args: Option<Vec<String>>,
) -> Result<Value, String> {
    let store = state.store.clone();
    let torr = state.torrserver.clone();
    let args = args.unwrap_or_default();

    match tauri::async_runtime::spawn_blocking(move || {
        let mut torr = torr.lock().expect("torrserver poisoned");
        torr.restart(&app, &store, args)
    })
    .await
    {
        Ok(v) => Ok(v),
        Err(err) => Ok(json!({ "success": false, "message": format!("Join error: {err}") })),
    }
}

#[tauri::command]
async fn torrserver_status(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let store = state.store.clone();
    let torr = state.torrserver.clone();

    match tauri::async_runtime::spawn_blocking(move || {
        let mut torr = torr.lock().expect("torrserver poisoned");
        torr.status(&app, &store)
    })
    .await
    {
        Ok(v) => Ok(v),
        Err(err) => Ok(json!({ "success": false, "message": format!("Join error: {err}") })),
    }
}

#[tauri::command]
async fn torrserver_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    version: Option<String>,
) -> Result<Value, String> {
    let store = state.store.clone();
    let torr = state.torrserver.clone();

    match tauri::async_runtime::spawn_blocking(move || {
        let mut torr = torr.lock().expect("torrserver poisoned");
        torr.download(&app, &store, version)
    })
    .await
    {
        Ok(v) => Ok(v),
        Err(err) => Ok(json!({ "success": false, "message": format!("Join error: {err}") })),
    }
}

#[tauri::command]
async fn torrserver_check_update(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let store = state.store.clone();
    let torr = state.torrserver.clone();

    match tauri::async_runtime::spawn_blocking(move || {
        let mut torr = torr.lock().expect("torrserver poisoned");
        torr.check_for_update(&store)
    })
    .await
    {
        Ok(v) => Ok(v),
        Err(err) => Ok(json!({ "hasUpdate": false, "message": format!("Join error: {err}") })),
    }
}

#[tauri::command]
async fn torrserver_update(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let store = state.store.clone();
    let torr = state.torrserver.clone();

    match tauri::async_runtime::spawn_blocking(move || {
        let mut torr = torr.lock().expect("torrserver poisoned");
        torr.update(&app, &store)
    })
    .await
    {
        Ok(v) => Ok(v),
        Err(err) => Ok(json!({ "success": false, "message": format!("Join error: {err}") })),
    }
}

#[tauri::command]
async fn torrserver_uninstall(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    keep_data: Option<bool>,
) -> Result<Value, String> {
    let store = state.store.clone();
    let torr = state.torrserver.clone();
    let keep_data = keep_data.unwrap_or(false);

    match tauri::async_runtime::spawn_blocking(move || {
        let mut torr = torr.lock().expect("torrserver poisoned");
        torr.uninstall(&app, &store, keep_data)
    })
    .await
    {
        Ok(v) => Ok(v),
        Err(err) => Ok(json!({ "success": false, "message": format!("Join error: {err}") })),
    }
}

#[tauri::command]
async fn torrserver_is_installed(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Value, String> {
    let store = state.store.clone();
    let torr = state.torrserver.clone();

    match tauri::async_runtime::spawn_blocking(move || {
        let torr = torr.lock().expect("torrserver poisoned");
        torr.is_installed(&app, &store)
    })
    .await
    {
        Ok(v) => Ok(v),
        Err(err) => Ok(json!({ "success": false, "message": format!("Join error: {err}") })),
    }
}


fn inject_plugin(window: &tauri::Webview) {
    let plugin_code = match serde_json::to_string(PLUGIN_JS) {
        Ok(v) => v,
        Err(_) => return,
    };

    let script = format!(
        r#"(function() {{
  const pluginCode = {plugin_code};
  const tryInject = () => {{
    try {{
      if (window.Prisma !== undefined) {{
        eval(pluginCode);
        console.log("Prisma plugin injected");
        return;
      }}
    }} catch (e) {{
      console.error("Prisma plugin inject failed", e);
      return;
    }}
    setTimeout(tryInject, 100);
  }};
  tryInject();
}})();"#
    );

    let _ = window.eval(&script);
}

fn save_window_state(window: &tauri::WebviewWindow, state: &tauri::State<'_, AppState>) {
    let position = window.outer_position();
    let size = window.outer_size();

    if let (Ok(pos), Ok(sz)) = (position, size) {
        let mut store = state.store.lock().expect("store poisoned");
        let _ = store.set(
            "windowState".into(),
            json!({
                "x": pos.x,
                "y": pos.y,
                "width": sz.width,
                "height": sz.height
            }),
        );
    }
}

fn apply_initial_window_state(window: &tauri::WebviewWindow, state: &tauri::State<'_, AppState>) {
    let store = state.store.lock().expect("store poisoned");

    if let Some(Value::Bool(fullscreen)) = store.get("fullscreen") {
        let _ = window.set_fullscreen(fullscreen);
    }

    if let Some(Value::Object(ws)) = store.get("windowState") {
        let x = ws.get("x").and_then(|v| v.as_i64());
        let y = ws.get("y").and_then(|v| v.as_i64());
        let w = ws.get("width").and_then(|v| v.as_u64());
        let h = ws.get("height").and_then(|v| v.as_u64());

        if let (Some(x), Some(y), Some(w), Some(h)) = (x, y, w, h) {
            let _ = window.set_position(tauri::Position::Physical(
                tauri::PhysicalPosition::new(x as i32, y as i32),
            ));
            let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
                w as u32, h as u32,
            )));
        }
    }
}

fn initialize_prisma_defaults(window: &tauri::Webview, state: &tauri::State<'_, AppState>) {
    let hostname = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "Prisma Desktop".to_string());

    let ts_port = {
        let guard = state.store.lock().expect("store poisoned");
        guard
            .get("tsPort")
            .and_then(|v| v.as_u64())
            .unwrap_or(8090)
    };

    let defaults = json!({
        "device_name": hostname,
        "platform": "desktop",
        "player_torrent": "other",
        "poster_size": "w500",
        "torrserver_url": format!("http://localhost:{}", ts_port),
        "torrserver_use_link": "one"
    });

    let defaults_js = match serde_json::to_string(&defaults) {
        Ok(v) => v,
        Err(_) => return,
    };

    let vlc_path = detect_vlc_path().map(|p| p.to_string_lossy().to_string());
    let vlc_path_js = match serde_json::to_string(&vlc_path) {
        Ok(v) => v,
        Err(_) => "null".to_string(),
    };

    let script = format!(
        r#"(function() {{
  try {{
    const defaults = {defaults_js};
    Object.entries(defaults).forEach(([key, value]) => {{
      if (localStorage.getItem(key) === null) localStorage.setItem(key, String(value));
    }});

    const vlcPath = {vlc_path_js};
    const existingPath = localStorage.getItem("player_nw_path");
    const playerTorrent = localStorage.getItem("player_torrent");

    if (vlcPath && (!existingPath || !existingPath.length) && playerTorrent !== "inner") {{
      localStorage.setItem("player_nw_path", vlcPath);
      localStorage.setItem("player_torrent", "other");
    }}
  }} catch (e) {{
    console.warn("Prisma defaults init failed", e);
  }}
}})();"#
    );

    let _ = window.eval(&script);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let path = store_path(&app.handle())?;
            let store = store::AppStore::load(path);

            let mut proxy = proxy::ProxyServerManager::new();
            let _ = proxy.start();

            app.manage(AppState {
                store: Arc::new(Mutex::new(store)),
                torrserver: Arc::new(Mutex::new(torrserver::TorrServerManager::new())),
                proxy: Arc::new(Mutex::new(proxy)),
                autostart_done: Arc::new(Mutex::new(false)),
            });

            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "main window is missing".to_string())?;

            let state = app.state::<AppState>();

            apply_initial_window_state(&window, &state);


            if let Some(Value::String(url)) = get_store_value(&state, "prismaUrl") {
                let sanitized = sanitize_prisma_url(&url);

                if sanitized != url {
                    let mut store = state.store.lock().expect("store poisoned");
                    let _ = store.set("prismaUrl".into(), Value::String(sanitized.clone()));
                }

                let script = format!(
                    "if (window.location.href !== {0}) window.location.href = {0};",
                    serde_json::to_string(&sanitized)
                        .unwrap_or_else(|_| "\"http://prisma.ws\"".into())
                );
                let _ = window.eval(&script);
            }

            let app_handle_for_events = app.handle().clone();
            window.on_window_event(move |event| {
                if let Some(main_window) = app_handle_for_events.get_webview_window("main") {
                    let state = app_handle_for_events.state::<AppState>();

                    match event {
                        WindowEvent::Moved(_)
                        | WindowEvent::Resized(_)
                        | WindowEvent::CloseRequested { .. } => {
                            save_window_state(&main_window, &state);
                        }
                        _ => {}
                    }
                }
            });

            Ok(())
        })
        .on_page_load(|window, _payload| {
            let state = window.app_handle().state::<AppState>();
            initialize_prisma_defaults(window, &state);

            let should_autostart = {
                let mut done = state.autostart_done.lock().expect("autostart_done poisoned");
                if *done {
                    false
                } else {
                    let enabled = get_store_value(&state, "tsAutoStart")
                        .map(|v| match v {
                            Value::Bool(b) => b,
                            Value::String(s) => matches!(s.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"),
                            Value::Number(n) => n.as_i64().unwrap_or(0) != 0,
                            _ => false,
                        })
                        .unwrap_or(false);

                    if enabled {
                        *done = true;
                    }

                    enabled
                }
            };

            if should_autostart {
                let app_handle = window.app_handle().clone();
                let store_state = state.store.clone();
                let torr_state = state.torrserver.clone();

                tauri::async_runtime::spawn_blocking(move || {
                    let mut torr = torr_state.lock().expect("torrserver poisoned");
                    let result = torr.start(&app_handle, &store_state, Vec::new());
                    let success = result.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
                    if !success {
                        eprintln!("TorrServer autostart failed: {}", result);
                    }
                });
            }

            let _ = window.eval(BRIDGE_JS);
            inject_plugin(window);
        })
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            store_get,
            store_set,
            store_has,
            store_delete,
            store_all,
            toggle_fullscreen,
            close_app,
            load_url,
            fs_exists_sync,
            child_process_spawn,
            open_folder,
            open_external_url,
            find_player,
            export_settings_to_file,
            import_settings_from_file,
            torrserver_start,
            torrserver_stop,
            torrserver_restart,
            torrserver_status,
            torrserver_download,
            torrserver_check_update,
            torrserver_update,
            torrserver_uninstall,
            torrserver_is_installed
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
