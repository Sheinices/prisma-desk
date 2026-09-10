use serde_json::{json, Map, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const MIRROR_HISTORY_LIMIT: usize = 8;

#[derive(Debug)]
pub struct AppStore {
    path: PathBuf,
    data: Map<String, Value>,
}

impl AppStore {
    pub fn load(path: PathBuf) -> Self {
        let defaults = default_store();

        let mut data = defaults.clone();

        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(Value::Object(existing)) = serde_json::from_str::<Value>(&raw) {
                // Старые установки уже работали с выбранным зеркалом
                // не показываем им экран первого запуска.
                let migrated = !existing.contains_key("mirrorConfirmed");

                for (k, v) in existing {
                    data.insert(k, v);
                }

                if migrated {
                    data.insert("mirrorConfirmed".into(), json!(true));
                }
            }
        }

        Self { path, data }
    }

    pub fn get(&self, key: &str) -> Option<Value> {
        self.data.get(key).cloned()
    }

    pub fn has(&self, key: &str) -> bool {
        self.data.contains_key(key)
    }

    pub fn set(&mut self, key: String, value: Value) -> Result<(), String> {
        self.data.insert(key, value);
        self.persist()
    }

    pub fn snapshot(&self) -> Value {
        Value::Object(self.data.clone())
    }

    pub fn delete(&mut self, key: &str) -> Result<bool, String> {
        let existed = self.data.remove(key).is_some();
        if existed {
            self.persist()?;
        }
        Ok(existed)
    }
    /// Пишем через временный файл и rename: обрыв на середине записи
    /// больше не оставляет пользователя с битым store.json и сброшенными настройками.
    fn persist(&self) -> Result<(), String> {
        ensure_parent_dir(&self.path)?;

        let serialized = serde_json::to_string_pretty(&self.data)
            .map_err(|e| format!("failed to serialize store: {e}"))?;

        let tmp = self.path.with_extension("json.tmp");

        {
            let mut file = fs::File::create(&tmp)
                .map_err(|e| format!("failed to create temp store file: {e}"))?;
            file.write_all(serialized.as_bytes())
                .map_err(|e| format!("failed to write temp store file: {e}"))?;
            file.sync_all()
                .map_err(|e| format!("failed to flush temp store file: {e}"))?;
        }

        fs::rename(&tmp, &self.path).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!("failed to replace store: {e}")
        })
    }
}

/// Свежий адрес встаёт первым, дубликаты убираются, длина ограничена.
pub fn push_mirror_history(history: &[String], url: &str, limit: usize) -> Vec<String> {
    let url = url.trim();

    if url.is_empty() {
        return history.to_vec();
    }

    let mut result = vec![url.to_string()];
    result.extend(
        history
            .iter()
            .filter(|item| item.as_str() != url)
            .cloned(),
    );
    result.truncate(limit.max(1));
    result
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };

    fs::create_dir_all(parent).map_err(|e| format!("failed to create store directory: {e}"))
}

fn default_store() -> Map<String, Value> {
    let mut map = Map::new();

    map.insert("prismaUrl".into(), json!("http://prisma.ws"));
    map.insert("mirrorConfirmed".into(), json!(false));
    map.insert("mirrorHistory".into(), json!([]));
    map.insert("fullscreen".into(), json!(false));
    map.insert("autoUpdate".into(), json!(true));
    map.insert("windowState".into(), json!({}));
    map.insert("tsVersion".into(), Value::Null);
    map.insert("tsPath".into(), Value::Null);
    map.insert("tsAutoStart".into(), json!(false));
    map.insert("tsPort".into(), json!(8090));

    map
}

#[cfg(test)]
mod tests {
    use super::{push_mirror_history, AppStore, MIRROR_HISTORY_LIMIT};
    use serde_json::{json, Value};
    use std::fs;
    use std::path::PathBuf;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "prisma-store-test-{}-{}",
            name,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir.join("store.json")
    }

    #[test]
    fn history_keeps_latest_first_without_duplicates() {
        let history = vec!["http://a".to_string(), "http://b".to_string()];

        assert_eq!(
            push_mirror_history(&history, "http://b", 8),
            vec!["http://b", "http://a"]
        );
        assert_eq!(
            push_mirror_history(&history, "  ", 8),
            history,
            "пустой адрес не должен попадать в историю"
        );
        assert_eq!(push_mirror_history(&history, "http://c", 2).len(), 2);
    }

    #[test]
    fn history_respects_the_limit() {
        let mut history: Vec<String> = Vec::new();
        for i in 0..20 {
            history = push_mirror_history(&history, &format!("http://{i}"), MIRROR_HISTORY_LIMIT);
        }

        assert_eq!(history.len(), MIRROR_HISTORY_LIMIT);
        assert_eq!(history[0], "http://19");
    }

    #[test]
    fn existing_installs_are_migrated_as_confirmed() {
        let path = temp_path("migration");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"prismaUrl":"http://mirror.tld"}"#).unwrap();

        let store = AppStore::load(path.clone());
        assert_eq!(store.get("mirrorConfirmed"), Some(json!(true)));
        assert_eq!(store.get("prismaUrl"), Some(json!("http://mirror.tld")));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn fresh_install_starts_unconfirmed() {
        let path = temp_path("fresh");
        let store = AppStore::load(path.clone());
        assert_eq!(store.get("mirrorConfirmed"), Some(json!(false)));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn writes_are_atomic_and_leave_no_temp_file() {
        let path = temp_path("persist");
        let mut store = AppStore::load(path.clone());
        store
            .set("prismaUrl".into(), Value::String("http://mirror.tld".into()))
            .unwrap();

        assert!(path.exists());
        assert!(!path.with_extension("json.tmp").exists());

        let reloaded = AppStore::load(path.clone());
        assert_eq!(reloaded.get("prismaUrl"), Some(json!("http://mirror.tld")));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
