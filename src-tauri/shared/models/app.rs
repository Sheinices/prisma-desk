// Prisma Desktop — десктопный клиент Prisma на Tauri.
// Copyright (C) 2026 Sheinices
//
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Prisma Desktop, licensed under the GNU Affero General
// Public License v3.0. See the LICENSE file in the project root for details.

use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

use crate::services::{proxy, store, torrserver};

/// Положение окна: x, y, width, height в физических пикселях.
pub type WindowRect = (i32, i32, u32, u32);

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Mutex<store::AppStore>>,
    /// Менеджер сам синхронизирует своё состояние, внешний мьютекс не нужен.
    pub torrserver: Arc<torrserver::TorrServerManager>,
    pub proxy: Arc<Mutex<proxy::ProxyServerManager>>,
    pub autostart_done: Arc<Mutex<bool>>,
    /// Текст ошибки старта VLC-прокси, если порт занят. None — прокси работает.
    pub proxy_error: Arc<Mutex<Option<String>>>,
    pub proxy_warned: Arc<Mutex<bool>>,
    /// Последнее положение окна (x, y, width, height), ещё не записанное на диск.
    pub pending_window_state: Arc<Mutex<Option<WindowRect>>>,
    /// Счётчик событий окна: отложенная запись выполняется, только если после
    /// её планирования не пришло новых событий.
    pub window_state_generation: Arc<AtomicU64>,
}
