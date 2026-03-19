use serde::Deserialize;
use serde_json::{json, Value};
use std::fs::{self, File};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

use crate::store;

const GITHUB_API: &str = "https://api.github.com/repos/YouROK/TorrServer/releases/latest";

#[derive(Debug)]
pub struct TorrServerManager {
    process: Option<Child>,
    status: String,
    current_version: Option<String>,
    executable_path: Option<PathBuf>,
}

#[derive(Debug)]
struct PlatformInfo {
    exe_name: String,
    save_dir: PathBuf,
    save_path: PathBuf,
    data_dir: PathBuf,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

impl Default for TorrServerManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TorrServerManager {
    fn is_port_open(port: u16) -> bool {
        let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
        TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
    }

    fn read_ts_port(store: &Arc<Mutex<store::AppStore>>) -> u16 {
        let guard = store.lock().expect("store poisoned");
        if let Some(v) = guard.get("tsPort") {
            if let Some(n) = v.as_u64() {
                return n as u16;
            }
            if let Some(s) = v.as_str() {
                if let Ok(n) = s.parse::<u16>() {
                    return n;
                }
            }
        }
        8090
    }

    pub fn new() -> Self {
        Self {
            process: None,
            status: "stopped".into(),
            current_version: None,
            executable_path: None,
        }
    }

    pub fn start(
        &mut self,
        app: &AppHandle,
        store: &Arc<Mutex<store::AppStore>>,
        args: Vec<String>,
    ) -> Value {
        self.refresh_process_status();

        let ts_port = Self::read_ts_port(store);

        if self.process.is_some() {
            return json!({ "success": false, "message": "TorrServer уже запущен" });
        }

        if Self::is_port_open(ts_port) {
            self.status = "running".into();
            return json!({
                "success": true,
                "message": "TorrServer уже запущен (внешний процесс)",
                "runningExternal": true,
                "port": ts_port
            });
        }

        let info = match self.get_platform_info(app) {
            Ok(info) => info,
            Err(err) => return json!({ "success": false, "message": err }),
        };

        if let Err(err) = self.ensure_directories(&info) {
            return json!({ "success": false, "message": err });
        }

        let saved_path = {
            let guard = store.lock().expect("store poisoned");
            guard
                .get("tsPath")
                .and_then(|v| v.as_str().map(|s| s.to_string()))
        };

        let mut executable_path = info.save_path.clone();
        if let Some(saved_path) = saved_path {
            let candidate = PathBuf::from(saved_path);
            if candidate.exists() {
                executable_path = candidate;
            }
        }

        if !executable_path.exists() {
            let dl = self.download(app, store, None);
            let success = dl.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
            if !success {
                return dl;
            }
        }

        let ts_port = ts_port as u64;

        let mut all_args = vec![
            "--port".to_string(),
            ts_port.to_string(),
            "--path".to_string(),
            info.data_dir.to_string_lossy().to_string(),
        ];
        all_args.extend(args);

        let mut command = Command::new(&executable_path);
        command
            .args(&all_args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .current_dir(&info.save_dir)
            .env("HOME", &info.save_dir)
            .env("USERPROFILE", &info.save_dir);

        self.status = "starting".into();

        let mut child = match command.spawn() {
            Ok(c) => c,
            Err(err) => {
                self.status = "error".into();
                return json!({ "success": false, "message": format!("Не удалось запустить TorrServer: {err}") });
            }
        };

        if let Some(stdout) = child.stdout.take() {
            let app_clone = app.clone();
            thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines().map_while(Result::ok) {
                    emit_torr_output(&app_clone, "stdout", Value::String(line));
                }
            });
        }

        if let Some(stderr) = child.stderr.take() {
            let app_clone = app.clone();
            thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    emit_torr_output(&app_clone, "stderr", Value::String(line));
                }
            });
        }

        thread::sleep(Duration::from_secs(2));

        match child.try_wait() {
            Ok(Some(status)) => {
                self.status = "error".into();
                json!({
                    "success": false,
                    "message": format!("Процесс завершился сразу после запуска: {status}")
                })
            }
            Ok(None) => {
                let pid = child.id();
                self.process = Some(child);
                self.status = "running".into();
                self.executable_path = Some(executable_path);

                emit_torr_output(app, "status", json!({ "message": "started", "pid": pid }));

                json!({
                    "success": true,
                    "message": "TorrServer запущен",
                    "pid": pid,
                    "port": ts_port
                })
            }
            Err(err) => {
                self.status = "error".into();
                json!({ "success": false, "message": format!("Ошибка проверки процесса: {err}") })
            }
        }
    }

    pub fn stop(&mut self, app: &AppHandle) -> Value {
        self.refresh_process_status();

        let Some(child) = self.process.as_mut() else {
            self.status = "stopped".into();
            return json!({ "success": false, "message": "TorrServer не запущен" });
        };

        if child.kill().is_err() {
            return json!({ "success": false, "message": "Не удалось остановить TorrServer" });
        }

        for _ in 0..50 {
            match child.try_wait() {
                Ok(Some(_)) => {
                    self.process = None;
                    self.status = "stopped".into();
                    emit_torr_output(app, "status", json!({ "message": "stopped" }));
                    return json!({ "success": true, "message": "TorrServer остановлен" });
                }
                Ok(None) => thread::sleep(Duration::from_millis(100)),
                Err(err) => {
                    self.process = None;
                    self.status = "error".into();
                    return json!({ "success": false, "message": format!("Ошибка остановки процесса: {err}") });
                }
            }
        }

        self.process = None;
        self.status = "stopped".into();
        json!({ "success": true, "message": "TorrServer остановлен (timeout wait)" })
    }

    pub fn restart(
        &mut self,
        app: &AppHandle,
        store: &Arc<Mutex<store::AppStore>>,
        args: Vec<String>,
    ) -> Value {
        let _ = self.stop(app);
        thread::sleep(Duration::from_millis(400));
        self.start(app, store, args)
    }

    pub fn uninstall(
        &mut self,
        app: &AppHandle,
        store: &Arc<Mutex<store::AppStore>>,
        keep_data: bool,
    ) -> Value {
        let _ = self.stop(app);

        let info = match self.get_platform_info(app) {
            Ok(info) => info,
            Err(err) => return json!({ "success": false, "message": err }),
        };

        let mut deleted_items = Vec::new();

        if info.save_path.exists() {
            if let Err(err) = fs::remove_file(&info.save_path) {
                return json!({ "success": false, "message": format!("Ошибка удаления бинарника: {err}") });
            }
            deleted_items.push(info.save_path.to_string_lossy().to_string());
        }

        if !keep_data && info.data_dir.exists() {
            if let Err(err) = fs::remove_dir_all(&info.data_dir) {
                return json!({ "success": false, "message": format!("Ошибка удаления папки данных: {err}") });
            }
            deleted_items.push(info.data_dir.to_string_lossy().to_string());
        }

        if !keep_data && info.save_dir.exists() {
            let _ = fs::remove_dir_all(&info.save_dir);
            deleted_items.push(info.save_dir.to_string_lossy().to_string());
        }

        {
            let mut guard = store.lock().expect("store poisoned");
            let _ = guard.delete("tsVersion");
            let _ = guard.delete("tsPath");
        }

        self.executable_path = None;
        self.current_version = None;
        self.status = "stopped".into();

        json!({
            "success": true,
            "message": if keep_data { "TorrServer удален (данные сохранены)" } else { "TorrServer полностью удален" },
            "deletedItems": deleted_items,
            "keepData": keep_data
        })
    }

    pub fn is_installed(&self, app: &AppHandle, store: &Arc<Mutex<store::AppStore>>) -> Value {
        let info = match self.get_platform_info(app) {
            Ok(info) => info,
            Err(err) => return json!({ "success": false, "message": err }),
        };

        let version = {
            let guard = store.lock().expect("store poisoned");
            guard
                .get("tsVersion")
                .and_then(|v| v.as_str().map(|s| s.to_string()))
        };

        let executable_exists = info.save_path.exists();

        json!({
            "installed": executable_exists && version.is_some(),
            "executableExists": executable_exists,
            "version": version,
            "path": info.save_path,
            "dataDir": info.data_dir
        })
    }

    pub fn check_for_update(&mut self, store: &Arc<Mutex<store::AppStore>>) -> Value {
        let current_version = {
            let guard = store.lock().expect("store poisoned");
            guard
                .get("tsVersion")
                .and_then(|v| v.as_str().map(|s| s.to_string()))
        };

        match self.get_latest_release() {
            Ok(release) => {
                let has_update = match current_version.as_deref() {
                    Some(current) => current != release.tag_name,
                    None => true,
                };

                self.current_version = Some(release.tag_name.clone());

                json!({
                    "hasUpdate": has_update,
                    "current": current_version,
                    "latest": release.tag_name
                })
            }
            Err(err) => json!({ "hasUpdate": false, "message": err }),
        }
    }

    pub fn update(&mut self, app: &AppHandle, store: &Arc<Mutex<store::AppStore>>) -> Value {
        let check = self.check_for_update(store);
        let has_update = check
            .get("hasUpdate")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if !has_update {
            return json!({
                "success": false,
                "message": "Уже установлена последняя версия",
                "current": check.get("current").cloned().unwrap_or(Value::Null)
            });
        }

        let was_running = self.process.is_some();
        if was_running {
            let _ = self.stop(app);
        }

        let download = self.download(app, store, None);
        let success = download
            .get("success")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if success && was_running {
            let _ = self.start(app, store, Vec::new());
        }

        download
    }

    pub fn status(&mut self, app: &AppHandle, store: &Arc<Mutex<store::AppStore>>) -> Value {
        self.refresh_process_status();

        let info = match self.get_platform_info(app) {
            Ok(info) => info,
            Err(err) => return json!({ "success": false, "message": err }),
        };

        let guard = store.lock().expect("store poisoned");
        let version = guard.get("tsVersion").unwrap_or(Value::Null);
        let path = guard.get("tsPath").unwrap_or(Value::Null);
        drop(guard);
        let port_u16 = Self::read_ts_port(store);
        let port = port_u16 as u64;
        let running_external = self.process.is_none() && Self::is_port_open(port_u16);
        let running = self.process.is_some() || running_external;

        if running && self.status == "stopped" {
            self.status = "running".into();
        }

        json!({
            "status": self.status,
            "running": running,
            "runningExternal": running_external,
            "pid": self.process.as_ref().map(|p| p.id()),
            "version": version,
            "path": path,
            "host": "localhost",
            "port": port,
            "dataDir": info.data_dir,
            "executableDir": info.save_dir,
            "installed": info.save_path.exists()
        })
    }

    pub fn download(
        &mut self,
        app: &AppHandle,
        store: &Arc<Mutex<store::AppStore>>,
        version: Option<String>,
    ) -> Value {
        let info = match self.get_platform_info(app) {
            Ok(info) => info,
            Err(err) => return json!({ "success": false, "message": err }),
        };

        if let Err(err) = self.ensure_directories(&info) {
            return json!({ "success": false, "message": err });
        }

        let release = match self.get_latest_release() {
            Ok(r) => r,
            Err(err) => return json!({ "success": false, "message": err }),
        };

        let target_version = version.unwrap_or_else(|| release.tag_name.clone());

        let asset = match release.assets.iter().find(|a| a.name == info.exe_name) {
            Some(asset) => asset,
            None => {
                let available = release
                    .assets
                    .iter()
                    .map(|a| a.name.clone())
                    .collect::<Vec<_>>()
                    .join(", ");
                return json!({
                    "success": false,
                    "message": format!(
                        "Не найден файл {} в релизе. Доступные файлы: {}",
                        info.exe_name, available
                    )
                });
            }
        };

        let client = match Self::http_client() {
            Ok(c) => c,
            Err(err) => return json!({ "success": false, "message": err }),
        };
        let mut response = match client
            .get(&asset.browser_download_url)
            .header("User-Agent", "Prisma-Desktop-Tauri")
            .send()
        {
            Ok(resp) => match resp.error_for_status() {
                Ok(ok) => ok,
                Err(err) => {
                    return json!({
                        "success": false,
                        "message": format!("Ошибка скачивания TorrServer: {err}")
                    })
                }
            },
            Err(err) => {
                return json!({
                    "success": false,
                    "message": format!("Ошибка скачивания TorrServer: {err}")
                })
            }
        };

        let mut file = match File::create(&info.save_path) {
            Ok(f) => f,
            Err(err) => {
                return json!({
                    "success": false,
                    "message": format!("Не удалось создать файл: {err}")
                })
            }
        };

        if let Err(err) = std::io::copy(&mut response, &mut file) {
            return json!({ "success": false, "message": format!("Ошибка записи файла: {err}") });
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Err(err) = fs::set_permissions(&info.save_path, fs::Permissions::from_mode(0o755)) {
                return json!({ "success": false, "message": format!("Ошибка chmod: {err}") });
            }
        }

        {
            let mut guard = store.lock().expect("store poisoned");
            let _ = guard.set("tsVersion".into(), Value::String(target_version.clone()));
            let _ = guard.set(
                "tsPath".into(),
                Value::String(info.save_path.to_string_lossy().to_string()),
            );
        }

        self.executable_path = Some(info.save_path.clone());
        self.current_version = Some(target_version.clone());

        json!({
            "success": true,
            "path": info.save_path,
            "version": target_version
        })
    }

    fn ensure_directories(&self, info: &PlatformInfo) -> Result<(), String> {
        fs::create_dir_all(&info.save_dir)
            .map_err(|e| format!("Ошибка создания директории TorrServer: {e}"))?;
        fs::create_dir_all(&info.data_dir)
            .map_err(|e| format!("Ошибка создания директории данных TorrServer: {e}"))?;
        Ok(())
    }

    fn http_client() -> Result<reqwest::blocking::Client, String> {
        reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(40))
            .build()
            .map_err(|e| format!("Ошибка инициализации HTTP-клиента: {e}"))
    }

    fn get_latest_release(&self) -> Result<GithubRelease, String> {
        let client = Self::http_client()?;
        let response = client
            .get(GITHUB_API)
            .header("User-Agent", "Prisma-Desktop-Tauri")
            .send()
            .map_err(|e| format!("Ошибка получения последней версии: {e}"))?
            .error_for_status()
            .map_err(|e| format!("Ошибка ответа GitHub API: {e}"))?;

        response
            .json::<GithubRelease>()
            .map_err(|e| format!("Ошибка парсинга ответа GitHub: {e}"))
    }

    fn get_platform_info(&self, app: &AppHandle) -> Result<PlatformInfo, String> {
        let platform = std::env::consts::OS.to_string();
        let arch = std::env::consts::ARCH;

        let os_name = match platform.as_str() {
            "windows" => "windows".to_string(),
            "macos" => "darwin".to_string(),
            "linux" => "linux".to_string(),
            other => return Err(format!("Неподдерживаемая ОС: {other}")),
        };

        let arch_suffix = match platform.as_str() {
            "windows" => {
                if arch == "x86_64" {
                    "amd64".to_string()
                } else {
                    arch.to_string()
                }
            }
            "macos" => {
                if arch == "aarch64" {
                    "arm64".to_string()
                } else {
                    "amd64".to_string()
                }
            }
            "linux" => {
                if arch == "x86_64" {
                    "amd64".to_string()
                } else if arch == "aarch64" {
                    "arm64".to_string()
                } else {
                    arch.to_string()
                }
            }
            _ => return Err(format!("Неподдерживаемая ОС: {}", platform)),
        };

        let exe_name = if platform == "windows" {
            format!("TorrServer-{os_name}-{arch_suffix}.exe")
        } else {
            format!("TorrServer-{os_name}-{arch_suffix}")
        };

        let save_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Не удалось получить app data dir: {e}"))?
            .join("torrserver");

        let save_path = save_dir.join(&exe_name);
        let data_dir = save_dir.join("data");

        Ok(PlatformInfo {
            exe_name,
            save_dir,
            save_path,
            data_dir,
        })
    }

    fn refresh_process_status(&mut self) {
        if let Some(child) = self.process.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    self.process = None;
                    self.status = "stopped".into();
                }
                Ok(None) => {
                    if self.status != "starting" {
                        self.status = "running".into();
                    }
                }
                Err(_) => {
                    self.process = None;
                    self.status = "error".into();
                }
            }
        }
    }
}

pub fn emit_torr_output(app: &AppHandle, output_type: &str, data: Value) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let payload = json!({
        "type": output_type,
        "data": data,
        "timestamp": ts
    });

    let _ = app.emit("torrserver-output", payload);
}
