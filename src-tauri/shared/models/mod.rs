// Prisma Desktop — десктопный клиент Prisma на Tauri.
// Copyright (C) 2026 Sheinices
//
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Prisma Desktop, licensed under the GNU Affero General
// Public License v3.0. See the LICENSE file in the project root for details.

pub mod app;
pub mod common;
pub mod process;

pub use app::AppState;
pub use common::CommandResult;
pub use process::ChildProcessSpawnRequest;
