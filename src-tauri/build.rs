// Prisma Desktop — десктопный клиент Prisma на Tauri.
// Copyright (C) 2026 Sheinices
//
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Prisma Desktop, licensed under the GNU Affero General
// Public License v3.0. See the LICENSE file in the project root for details.

use tauri_build::{AppManifest, Attributes};

/// Все команды приложения из `generate_handler!` в core/lib.rs.
/// С Tauri 2.12 команды, вызываемые с удалённого URL (клиент Prisma живёт
/// на зеркале), проверяются по ACL всегда, поэтому для каждой генерируется
/// разрешение `allow-<команда через дефис>` и выдаётся в
/// capabilities/default.json. Список сверяет scripts/check-commands-acl.mjs.
const APP_COMMANDS: &[&str] = &[
    "media_subtitle_tracks",
    "media_subtitle_start",
    "media_subtitle_read",
    "media_subtitle_stop",
    "media_video_info",
    "media_video_start",
    "media_video_read",
    "media_video_stop",
    "media_video_keep_alive",
    "media_audio_probe",
    "media_audio_start",
    "media_audio_read",
    "media_audio_stop",
    "get_app_version",
    "app_installation_info",
    "app_check_update",
    "app_install_update",
    "store_get",
    "store_set",
    "store_has",
    "store_delete",
    "store_all",
    "toggle_fullscreen",
    "close_app",
    "load_url",
    "mirror_state",
    "mirror_check",
    "mirror_apply",
    "proxy_status",
    "proxy_restart",
    "fs_exists_sync",
    "child_process_spawn",
    "open_folder",
    "open_external_url",
    "find_player",
    "player_detect",
    "player_choose_path",
    "player_validate",
    "player_start",
    "player_read_state",
    "player_seek",
    "export_settings_to_file",
    "import_settings_from_file",
    "torrserver_start",
    "torrserver_stop",
    "torrserver_restart",
    "torrserver_status",
    "torrserver_download",
    "torrserver_check_update",
    "torrserver_update",
    "torrserver_uninstall",
    "torrserver_is_installed",
];

fn main() {
    tauri_build::try_build(
        Attributes::new().app_manifest(AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
