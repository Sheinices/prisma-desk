// Prisma Desktop — десктопный клиент Prisma на Tauri.
// Copyright (C) 2026 Sheinices
//
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Prisma Desktop, licensed under the GNU Affero General
// Public License v3.0. See the LICENSE file in the project root for details.

use std::sync::OnceLock;
use std::time::Duration;

use reqwest::blocking::Client;

const USER_AGENT: &str = "Prisma-Desktop-Tauri";

/// Общий блокирующий HTTP-клиент. Создание клиента загружает корневые
/// сертификаты и стоит десятки миллисекунд, поэтому делаем это один раз.
/// Таймаут ответа задаётся на каждый запрос через `RequestBuilder::timeout`.
pub fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();

    CLIENT.get_or_init(|| {
        Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("failed to build HTTP client")
    })
}
