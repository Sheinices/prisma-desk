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

/// reqwest собран с `rustls-no-provider`, поэтому криптопровайдер нужно
/// установить в процессе один раз до первого клиента. Ставим ring, как и
/// tauri-plugin-updater; если провайдер уже есть, ничего не делаем.
pub fn install_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// Общий блокирующий HTTP-клиент. Создание клиента загружает корневые
/// сертификаты и стоит десятки миллисекунд, поэтому делаем это один раз.
/// Таймаут ответа задаётся на каждый запрос через `RequestBuilder::timeout`.
pub fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();

    CLIENT.get_or_init(|| {
        install_crypto_provider();

        Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("failed to build HTTP client")
    })
}

#[cfg(test)]
mod tests {
    use super::client;

    /// Живой HTTPS-запрос: проверяет, что rustls с провайдером ring и системными
    /// корневыми сертификатами реально работает. Нужна сеть, поэтому по умолчанию
    /// пропускается: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn https_request_works_with_system_roots() {
        let response = client()
            .get("https://api.github.com/")
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .expect("HTTPS request failed");

        assert!(response.status().is_success() || response.status().as_u16() == 403);
    }
}
