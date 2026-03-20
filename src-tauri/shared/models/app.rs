use std::sync::{Arc, Mutex};

use crate::services::{proxy, store, torrserver};

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Mutex<store::AppStore>>,
    pub torrserver: Arc<Mutex<torrserver::TorrServerManager>>,
    pub proxy: Arc<Mutex<proxy::ProxyServerManager>>,
    pub autostart_done: Arc<Mutex<bool>>,
}
