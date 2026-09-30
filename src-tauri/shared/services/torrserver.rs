// Prisma Desktop — десктопный клиент Prisma на Tauri.
// Copyright (C) 2026 Sheinices
//
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Prisma Desktop, licensed under the GNU Affero General
// Public License v3.0. See the LICENSE file in the project root for details.

use serde::Deserialize;
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

use crate::services::{http, store};

const GITHUB_API: &str = "https://api.github.com/repos/YouROK/TorrServer/releases/latest";
const API_TIMEOUT: Duration = Duration::from_secs(40);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(40);
const DEFAULT_PORT: u16 = 8090;

/// Сколько ждём после spawn, чтобы отличить нормальный старт от мгновенного падения.
const START_PROBE_DELAY: Duration = Duration::from_secs(2);

/// Менеджер встроенного TorrServer.
///
/// Долгие операции (скачивание, запуск с проверочной паузой, остановка)
/// не держат мьютекс состояния: они лишь помечают менеджер занятым через
/// `busy`, а состояние захватывают короткими отрезками. Поэтому `status`
/// отвечает мгновенно даже во время установки, а две долгие операции
/// не могут пойти одновременно.
#[derive(Debug, Default)]
pub struct TorrServerManager {
    inner: Mutex<Inner>,
    /// Название текущей долгой операции, если она идёт.
    busy: Mutex<Option<&'static str>>,
}

#[derive(Debug, Default)]
struct Inner {
    process: Option<Child>,
    status: Status,
    current_version: Option<String>,
    executable_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Status {
    #[default]
    Stopped,
    Starting,
    Running,
    Error,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Status::Stopped => "stopped",
            Status::Starting => "starting",
            Status::Running => "running",
            Status::Error => "error",
        }
    }
}

/// Снимает отметку занятости при выходе из операции, включая ранний return.
struct BusyGuard<'a> {
    slot: &'a Mutex<Option<&'static str>>,
}

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        *self.slot.lock().expect("busy poisoned") = None;
    }
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

type Store = Arc<Mutex<store::AppStore>>;

fn is_port_open(port: u16) -> bool {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

fn read_ts_port(store: &Store) -> u16 {
    let guard = store.lock().expect("store poisoned");
    let Some(value) = guard.get("tsPort") else {
        return DEFAULT_PORT;
    };

    value
        .as_u64()
        .and_then(|n| u16::try_from(n).ok())
        .or_else(|| value.as_str().and_then(|s| s.parse::<u16>().ok()))
        .unwrap_or(DEFAULT_PORT)
}

fn store_string(store: &Store, key: &str) -> Option<String> {
    let guard = store.lock().expect("store poisoned");
    guard.get(key).and_then(|v| v.as_str().map(str::to_string))
}

fn success_of(result: &Value) -> bool {
    result
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

impl Inner {
    /// Синхронизирует `status` с реальным состоянием дочернего процесса.
    fn refresh(&mut self) {
        let Some(child) = self.process.as_mut() else {
            return;
        };

        match child.try_wait() {
            Ok(Some(_)) => {
                self.process = None;
                self.status = Status::Stopped;
            }
            Ok(None) => {
                if self.status != Status::Starting {
                    self.status = Status::Running;
                }
            }
            Err(_) => {
                self.process = None;
                self.status = Status::Error;
            }
        }
    }
}

impl TorrServerManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().expect("torrserver poisoned")
    }

    fn current_busy(&self) -> Option<&'static str> {
        *self.busy.lock().expect("busy poisoned")
    }

    /// Помечает менеджер занятым или возвращает ошибку, если долгая
    /// операция уже идёт.
    fn acquire_busy(&self, operation: &'static str) -> Result<BusyGuard<'_>, Value> {
        let mut slot = self.busy.lock().expect("busy poisoned");

        if let Some(current) = *slot {
            return Err(json!({
                "success": false,
                "busy": current,
                "message": format!("TorrServer занят: выполняется операция «{current}»")
            }));
        }

        *slot = Some(operation);
        Ok(BusyGuard { slot: &self.busy })
    }

    // --- Публичные операции: каждая долгая берёт busy-guard -----------------

    pub fn start(&self, app: &AppHandle, store: &Store, args: Vec<String>) -> Value {
        let _busy = match self.acquire_busy("start") {
            Ok(guard) => guard,
            Err(err) => return err,
        };
        self.start_inner(app, store, args)
    }

    pub fn stop(&self, app: &AppHandle) -> Value {
        let _busy = match self.acquire_busy("stop") {
            Ok(guard) => guard,
            Err(err) => return err,
        };
        self.stop_inner(app)
    }

    pub fn restart(&self, app: &AppHandle, store: &Store, args: Vec<String>) -> Value {
        let _busy = match self.acquire_busy("restart") {
            Ok(guard) => guard,
            Err(err) => return err,
        };

        let _ = self.stop_inner(app);
        thread::sleep(Duration::from_millis(400));
        self.start_inner(app, store, args)
    }

    pub fn download(&self, app: &AppHandle, store: &Store, version: Option<String>) -> Value {
        let _busy = match self.acquire_busy("download") {
            Ok(guard) => guard,
            Err(err) => return err,
        };
        self.download_inner(app, store, version)
    }

    pub fn update(&self, app: &AppHandle, store: &Store) -> Value {
        let _busy = match self.acquire_busy("update") {
            Ok(guard) => guard,
            Err(err) => return err,
        };

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

        let was_running = {
            let mut inner = self.inner();
            inner.refresh();
            inner.process.is_some()
        };

        if was_running {
            let _ = self.stop_inner(app);
        }

        let download = self.download_inner(app, store, None);

        if success_of(&download) && was_running {
            let _ = self.start_inner(app, store, Vec::new());
        }

        download
    }

    pub fn uninstall(&self, app: &AppHandle, store: &Store, keep_data: bool) -> Value {
        let _busy = match self.acquire_busy("uninstall") {
            Ok(guard) => guard,
            Err(err) => return err,
        };

        let _ = self.stop_inner(app);

        let info = match get_platform_info(app) {
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

        {
            let mut inner = self.inner();
            inner.executable_path = None;
            inner.current_version = None;
            inner.status = Status::Stopped;
        }

        json!({
            "success": true,
            "message": if keep_data { "TorrServer удален (данные сохранены)" } else { "TorrServer полностью удален" },
            "deletedItems": deleted_items,
            "keepData": keep_data
        })
    }

    // --- Быстрые запросы: не ждут долгих операций ---------------------------

    pub fn is_installed(&self, app: &AppHandle, store: &Store) -> Value {
        let info = match get_platform_info(app) {
            Ok(info) => info,
            Err(err) => return json!({ "success": false, "message": err }),
        };

        let version = store_string(store, "tsVersion");
        let executable_exists = info.save_path.exists();

        json!({
            "installed": executable_exists && version.is_some(),
            "executableExists": executable_exists,
            "version": version,
            "path": info.save_path,
            "dataDir": info.data_dir
        })
    }

    pub fn check_for_update(&self, store: &Store) -> Value {
        let current_version = store_string(store, "tsVersion");

        match get_latest_release() {
            Ok(release) => {
                let has_update = match current_version.as_deref() {
                    Some(current) => current != release.tag_name,
                    None => true,
                };

                self.inner().current_version = Some(release.tag_name.clone());

                json!({
                    "hasUpdate": has_update,
                    "current": current_version,
                    "latest": release.tag_name
                })
            }
            Err(err) => json!({ "hasUpdate": false, "message": err }),
        }
    }

    pub fn status(&self, app: &AppHandle, store: &Store) -> Value {
        let info = match get_platform_info(app) {
            Ok(info) => info,
            Err(err) => return json!({ "success": false, "message": err }),
        };

        let (version, path) = {
            let guard = store.lock().expect("store poisoned");
            (
                guard.get("tsVersion").unwrap_or(Value::Null),
                guard.get("tsPath").unwrap_or(Value::Null),
            )
        };
        let port = read_ts_port(store);

        // Состояние процесса читаем коротко, а TCP-пробу порта делаем без мьютекса.
        let (pid, status) = {
            let mut inner = self.inner();
            inner.refresh();
            (inner.process.as_ref().map(Child::id), inner.status)
        };

        let running_external = pid.is_none() && is_port_open(port);
        let running = pid.is_some() || running_external;

        let status = if running && status == Status::Stopped {
            self.inner().status = Status::Running;
            Status::Running
        } else {
            status
        };

        json!({
            "status": status.as_str(),
            "busy": self.current_busy(),
            "running": running,
            "runningExternal": running_external,
            "pid": pid,
            "version": version,
            "path": path,
            "host": "localhost",
            "port": port,
            "dataDir": info.data_dir,
            "executableDir": info.save_dir,
            "installed": info.save_path.exists()
        })
    }

    // --- Реализации долгих операций: вызываются только под busy-guard -------

    fn start_inner(&self, app: &AppHandle, store: &Store, args: Vec<String>) -> Value {
        {
            let mut inner = self.inner();
            inner.refresh();
            if inner.process.is_some() {
                return json!({ "success": false, "message": "TorrServer уже запущен" });
            }
        }

        let ts_port = read_ts_port(store);

        let info = match get_platform_info(app) {
            Ok(info) => info,
            Err(err) => return json!({ "success": false, "message": err }),
        };

        if is_port_open(ts_port) {
            if !info.save_path.exists() {
                let dl = self.download_inner(app, store, None);
                if !success_of(&dl) {
                    return dl;
                }
            }

            {
                let mut inner = self.inner();
                inner.executable_path = Some(info.save_path.clone());
                inner.status = Status::Running;
            }

            return json!({
                "success": true,
                "message": "Порт TorrServer уже занят внешним процессом. Локальный бинарник установлен.",
                "runningExternal": true,
                "port": ts_port,
                "installed": true
            });
        }

        if let Err(err) = ensure_directories(&info) {
            return json!({ "success": false, "message": err });
        }

        let mut executable_path = info.save_path.clone();
        if let Some(saved_path) = store_string(store, "tsPath") {
            let candidate = PathBuf::from(saved_path);
            if candidate.exists() {
                executable_path = candidate;
            }
        }

        if !executable_path.exists() {
            let dl = self.download_inner(app, store, None);
            if !success_of(&dl) {
                return dl;
            }
        }

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

        self.inner().status = Status::Starting;

        let mut child = match command.spawn() {
            Ok(c) => c,
            Err(err) => {
                self.inner().status = Status::Error;
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

        // Процесс уже виден в статусе как "starting", пока идёт проверочная пауза.
        let pid = child.id();
        self.inner().process = Some(child);

        thread::sleep(START_PROBE_DELAY);

        let mut inner = self.inner();
        let Some(child) = inner.process.as_mut() else {
            // Кто-то успел убрать процесс (например, exit детектирован через refresh).
            inner.status = Status::Error;
            return json!({
                "success": false,
                "message": "Процесс завершился сразу после запуска"
            });
        };

        match child.try_wait() {
            Ok(Some(status)) => {
                inner.process = None;
                inner.status = Status::Error;
                json!({
                    "success": false,
                    "message": format!("Процесс завершился сразу после запуска: {status}")
                })
            }
            Ok(None) => {
                inner.status = Status::Running;
                inner.executable_path = Some(executable_path);
                drop(inner);

                emit_torr_output(app, "status", json!({ "message": "started", "pid": pid }));

                json!({
                    "success": true,
                    "message": "TorrServer запущен",
                    "pid": pid,
                    "port": ts_port
                })
            }
            Err(err) => {
                inner.process = None;
                inner.status = Status::Error;
                json!({ "success": false, "message": format!("Ошибка проверки процесса: {err}") })
            }
        }
    }

    fn stop_inner(&self, app: &AppHandle) -> Value {
        // Забираем процесс из состояния и ждём его без мьютекса: пока busy-guard
        // у нас, никто не запустит второй экземпляр, а статус остаётся доступным.
        let child = {
            let mut inner = self.inner();
            inner.refresh();
            inner.process.take()
        };

        let Some(mut child) = child else {
            self.inner().status = Status::Stopped;
            return json!({ "success": false, "message": "TorrServer не запущен" });
        };

        if child.kill().is_err() {
            self.inner().process = Some(child);
            return json!({ "success": false, "message": "Не удалось остановить TorrServer" });
        }

        for _ in 0..50 {
            match child.try_wait() {
                Ok(Some(_)) => {
                    self.inner().status = Status::Stopped;
                    emit_torr_output(app, "status", json!({ "message": "stopped" }));
                    return json!({ "success": true, "message": "TorrServer остановлен" });
                }
                Ok(None) => thread::sleep(Duration::from_millis(100)),
                Err(err) => {
                    self.inner().status = Status::Error;
                    return json!({ "success": false, "message": format!("Ошибка остановки процесса: {err}") });
                }
            }
        }

        self.inner().status = Status::Stopped;
        json!({ "success": true, "message": "TorrServer остановлен (timeout wait)" })
    }

    fn download_inner(&self, app: &AppHandle, store: &Store, version: Option<String>) -> Value {
        let info = match get_platform_info(app) {
            Ok(info) => info,
            Err(err) => return json!({ "success": false, "message": err }),
        };

        if let Err(err) = ensure_directories(&info) {
            return json!({ "success": false, "message": err });
        }

        let release = match get_latest_release() {
            Ok(r) => r,
            Err(err) => return json!({ "success": false, "message": err }),
        };

        let target_version = version.unwrap_or_else(|| release.tag_name.clone());

        let expected_name = info.exe_name.clone();
        let expected_stem = expected_name.trim_end_matches(".exe").to_string();

        let asset = release
            .assets
            .iter()
            .find(|a| a.name == expected_name)
            .or_else(|| release.assets.iter().find(|a| a.name == expected_stem))
            .or_else(|| {
                release
                    .assets
                    .iter()
                    .find(|a| a.name.starts_with(&expected_stem))
            });

        let Some(asset) = asset else {
            let available = release
                .assets
                .iter()
                .map(|a| a.name.clone())
                .collect::<Vec<_>>()
                .join(", ");
            return json!({
                "success": false,
                "message": format!(
                    "Не найден файл TorrServer для платформы ({expected_name}). Доступные файлы: {available}",
                )
            });
        };

        let mut response = match http::client()
            .get(&asset.browser_download_url)
            .timeout(DOWNLOAD_TIMEOUT)
            .send()
            .and_then(|resp| resp.error_for_status())
        {
            Ok(resp) => resp,
            Err(err) => {
                return json!({
                    "success": false,
                    "message": format!("Ошибка скачивания TorrServer: {err}")
                })
            }
        };

        // Качаем во временный файл и подменяем атомарно: обрыв сети не оставит
        // полубитый бинарник, а работающий exe на Windows не будет обрезан.
        let tmp_path = info.save_dir.join(format!("{}.part", info.exe_name));

        let written = File::create(&tmp_path)
            .map_err(|err| format!("Не удалось создать файл: {err}"))
            .and_then(|mut file| {
                std::io::copy(&mut response, &mut file)
                    .map_err(|err| format!("Ошибка записи файла: {err}"))
            });

        if let Err(message) = written {
            let _ = fs::remove_file(&tmp_path);
            return json!({ "success": false, "message": message });
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Err(err) = fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o755)) {
                let _ = fs::remove_file(&tmp_path);
                return json!({ "success": false, "message": format!("Ошибка chmod: {err}") });
            }
        }

        if let Err(err) = fs::rename(&tmp_path, &info.save_path) {
            let _ = fs::remove_file(&tmp_path);
            return json!({
                "success": false,
                "message": format!("Не удалось заменить бинарник TorrServer: {err}")
            });
        }

        {
            let mut guard = store.lock().expect("store poisoned");
            let _ = guard.set("tsVersion".into(), Value::String(target_version.clone()));
            let _ = guard.set(
                "tsPath".into(),
                Value::String(info.save_path.to_string_lossy().to_string()),
            );
        }

        {
            let mut inner = self.inner();
            inner.executable_path = Some(info.save_path.clone());
            inner.current_version = Some(target_version.clone());
        }

        json!({
            "success": true,
            "path": info.save_path,
            "version": target_version
        })
    }
}

fn ensure_directories(info: &PlatformInfo) -> Result<(), String> {
    fs::create_dir_all(&info.save_dir)
        .map_err(|e| format!("Ошибка создания директории TorrServer: {e}"))?;
    fs::create_dir_all(&info.data_dir)
        .map_err(|e| format!("Ошибка создания директории данных TorrServer: {e}"))?;
    Ok(())
}

fn get_latest_release() -> Result<GithubRelease, String> {
    let response = http::client()
        .get(GITHUB_API)
        .timeout(API_TIMEOUT)
        .send()
        .map_err(|e| format!("Ошибка получения последней версии: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Ошибка ответа GitHub API: {e}"))?;

    response
        .json::<GithubRelease>()
        .map_err(|e| format!("Ошибка парсинга ответа GitHub: {e}"))
}

fn get_platform_info(app: &AppHandle) -> Result<PlatformInfo, String> {
    let platform = std::env::consts::OS;
    let arch = std::env::consts::ARCH;

    let os_name = match platform {
        "windows" => "windows",
        "macos" => "darwin",
        "linux" => "linux",
        other => return Err(format!("Неподдерживаемая ОС: {other}")),
    };

    let arch_suffix = match (platform, arch) {
        (_, "x86_64") => "amd64",
        ("macos", _) | ("linux", "aarch64") => "arm64",
        _ => arch,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn busy_guard_blocks_second_long_operation_and_releases_on_drop() {
        let manager = TorrServerManager::new();

        let guard = manager.acquire_busy("download").expect("first acquire");
        let second = manager
            .acquire_busy("start")
            .err()
            .expect("second must fail");
        assert_eq!(second["busy"], "download");
        assert_eq!(manager.current_busy(), Some("download"));

        drop(guard);
        assert_eq!(manager.current_busy(), None);
        assert!(manager.acquire_busy("start").is_ok());
    }

    #[test]
    fn port_falls_back_to_default_on_garbage() {
        let path = std::env::temp_dir().join(format!("prisma-ts-port-{}.json", std::process::id()));
        let store: Store = Arc::new(Mutex::new(store::AppStore::load(path.clone())));

        assert_eq!(read_ts_port(&store), DEFAULT_PORT);

        store
            .lock()
            .unwrap()
            .set("tsPort".into(), json!("8123"))
            .unwrap();
        assert_eq!(read_ts_port(&store), 8123);

        store
            .lock()
            .unwrap()
            .set("tsPort".into(), json!(70000))
            .unwrap();
        assert_eq!(read_ts_port(&store), DEFAULT_PORT);

        let _ = fs::remove_file(path);
    }
}
