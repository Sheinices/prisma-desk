// Prisma Desktop — десктопный клиент Prisma на Tauri.
// Copyright (C) 2026 Sheinices
// SPDX-License-Identifier: AGPL-3.0-only

//! Isolated browser integration fixture. Reuses the production decoder; never
//! touches application settings. Run via scripts/verify-media-webkit.swift.
#[path = "../shared/services/media_audio.rs"]
pub mod media_audio;

use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tiny_http::{Header, Request, Response, Server};

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name, value).unwrap()
}

fn main() {
    let args: Vec<_> = std::env::args().collect();
    let ffmpeg = PathBuf::from(&args[1]);
    let ffprobe = PathBuf::from(&args[2]);
    let fixture = std::env::temp_dir().join(format!("prisma-webkit-{}.mp4", std::process::id()));
    assert!(Command::new(&ffmpeg)
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=128x128:r=25:d=20",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=20",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:sample_rate=48000:duration=20",
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-map",
            "2:a",
            "-c:v",
            "libx264",
            "-profile:v",
            "baseline",
            "-pix_fmt",
            "yuv420p",
            "-c:a:0",
            "ac3",
            "-c:a:1",
            "eac3",
            "-ac:a:1",
            "6",
            "-disposition:a:0",
            "default",
            "-disposition:a:1",
            "0",
            "-movflags",
            "+faststart",
        ])
        .arg(&fixture)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .status()
        .unwrap()
        .success());
    let media = Arc::new(std::fs::read(&fixture).unwrap());
    std::fs::remove_file(&fixture).unwrap();
    let server = Server::http(("127.0.0.1", 0)).unwrap();
    let origin = format!("http://{}", server.server_addr());
    let url = format!("{origin}/media.mp4");
    let decoder = Arc::new(media_audio::AudioDecoder::default());
    let shutdown = Arc::new(AtomicBool::new(false));
    println!("{origin}");
    std::io::stdout().flush().unwrap();
    while !shutdown.load(Ordering::Relaxed) {
        let Some(request) = server.recv_timeout(Duration::from_millis(100)).unwrap() else {
            continue;
        };
        let (ffmpeg, ffprobe, url, media, decoder, shutdown) = (
            ffmpeg.clone(),
            ffprobe.clone(),
            url.clone(),
            media.clone(),
            decoder.clone(),
            shutdown.clone(),
        );
        std::thread::spawn(move || {
            serve(
                request, &ffmpeg, &ffprobe, &url, &media, &decoder, &shutdown,
            )
        });
    }
    decoder.stop(None);
}

fn serve(
    mut request: Request,
    ffmpeg: &std::path::Path,
    ffprobe: &std::path::Path,
    url: &str,
    media: &[u8],
    decoder: &media_audio::AudioDecoder,
    shutdown: &AtomicBool,
) {
    match request.url() {
        "/" => {
            let _ = request.respond(
                Response::from_string(include_str!("../../scripts/media-webkit-test.html"))
                    .with_header(header("Content-Type", "text/html")),
            );
        }
        "/media-audio.js" => {
            let _ = request.respond(
                Response::from_string(include_str!("../module/media-audio.js"))
                    .with_header(header("Content-Type", "application/javascript")),
            );
        }
        "/media.mp4" => {
            let range = request
                .headers()
                .iter()
                .find(|h| h.field.equiv("Range"))
                .and_then(|h| h.value.as_str().strip_prefix("bytes="))
                .and_then(|s| s.split_once('-'));
            let start = range
                .and_then(|(start, _)| start.parse::<usize>().ok())
                .unwrap_or(0);
            let end = range
                .and_then(|(_, end)| end.parse::<usize>().ok())
                .unwrap_or(media.len() - 1)
                .min(media.len() - 1);
            if start > end {
                let _ = request.respond(
                    Response::empty(416)
                        .with_header(header("Content-Range", &format!("bytes */{}", media.len()))),
                );
                return;
            }
            let mut response = Response::from_data(media[start..=end].to_vec())
                .with_header(header("Content-Type", "video/mp4"))
                .with_header(header("Accept-Ranges", "bytes"));
            if range.is_some() {
                response = response.with_status_code(206).with_header(header(
                    "Content-Range",
                    &format!("bytes {start}-{end}/{}", media.len()),
                ));
            }
            let _ = request.respond(response);
        }
        "/shutdown" => {
            decoder.stop(None);
            shutdown.store(true, Ordering::Relaxed);
            let _ = request.respond(Response::empty(200));
        }
        _ => {
            let route = request.url().to_string();
            let mut body = String::new();
            let _ = request.as_reader().take(16384).read_to_string(&mut body);
            let input: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            // This fixture server may only decode its synthetic media.
            let result: Result<Vec<u8>, String> = (|| {
                if matches!(
                    route.as_str(),
                    "/api/media_audio_probe" | "/api/media_audio_start"
                ) && input["url"] != url
                {
                    return Err("fixture URL required".into());
                }
                match route.as_str() {
                    "/api/media_audio_probe" => {
                        Ok(serde_json::to_vec(&media_audio::probe(ffprobe, url)?).unwrap())
                    }
                    "/api/media_audio_start" => Ok(serde_json::to_vec(&decoder.start(
                        ffmpeg,
                        url,
                        input["stream"].as_u64().unwrap_or(0) as u32,
                        input["start"].as_f64().unwrap_or(0.0),
                        input["channels"].as_u64().unwrap_or(2) as usize,
                        input["rate"].as_f64().unwrap_or(1.0),
                    )?)
                    .unwrap()),
                    "/api/media_audio_read" => decoder.read(input["id"].as_u64().unwrap_or(0)),
                    "/api/media_audio_stop" => {
                        decoder.stop(input["id"].as_u64());
                        Ok(b"null".to_vec())
                    }
                    _ => Err("unknown route".into()),
                }
            })();
            let response = match result {
                Ok(bytes) => Response::from_data(bytes),
                Err(message) => {
                    Response::from_data(serde_json::to_vec(&json!({"message": message})).unwrap())
                        .with_status_code(500)
                }
            };
            let _ = request.respond(response);
        }
    }
}

use std::io::Read;
