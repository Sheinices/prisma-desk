use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

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
                for (k, v) in existing {
                    data.insert(k, v);
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
    fn persist(&self) -> Result<(), String> {
        ensure_parent_dir(&self.path)?;

        let serialized = serde_json::to_string_pretty(&self.data)
            .map_err(|e| format!("failed to serialize store: {e}"))?;
        fs::write(&self.path, serialized).map_err(|e| format!("failed to write store: {e}"))
    }
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
    map.insert("fullscreen".into(), json!(false));
    map.insert("autoUpdate".into(), json!(true));
    map.insert("windowState".into(), json!({}));
    map.insert("tsVersion".into(), Value::Null);
    map.insert("tsPath".into(), Value::Null);
    map.insert("tsAutoStart".into(), json!(false));
    map.insert("tsPort".into(), json!(8090));

    map
}
