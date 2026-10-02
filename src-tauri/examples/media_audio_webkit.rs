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
    let mkv = std::env::var("PRISMA_TEST_MKV").is_ok();
    let fixture = std::env::temp_dir().join(format!(
        "prisma-webkit-{}.{}",
        std::process::id(),
        if mkv { "mkv" } else { "mp4" }
    ));
    let subtitles = std::env::temp_dir().join(format!("prisma-webkit-{}.srt", std::process::id()));
    std::fs::write(&subtitles, "1\n00:00:00,100 --> 00:00:12,000\nТестовые субтитры\n\n2\n00:00:14,000 --> 00:00:40,000\nПосле перемотки\n").unwrap();
    assert!(Command::new(&ffmpeg)
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=128x128:r=25:d=45",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=45",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:sample_rate=48000:duration=45",
            "-i",
            subtitles.to_str().unwrap(),
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-map",
            "2:a",
            "-map",
            "3:s",
            "-c:s",
            if mkv { "srt" } else { "mov_text" },
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
    std::fs::remove_file(&subtitles).unwrap();
    let server = Server::http(("127.0.0.1", 0)).unwrap();
    let origin = format!("http://{}", server.server_addr());
    let url = std::env::var("PRISMA_TEST_URL")
        .unwrap_or_else(|_| format!("{origin}/media.{}", if mkv { "mkv" } else { "mp4" }));
    let subtitles = Arc::new(media_audio::AudioDecoder::default());
    let remuxer = Arc::new(media_audio::AudioDecoder::default());
    let decoder = Arc::new(media_audio::AudioDecoder::default());
    let shutdown = Arc::new(AtomicBool::new(false));
    println!("{origin}");
    std::io::stdout().flush().unwrap();
    while !shutdown.load(Ordering::Relaxed) {
        let Some(request) = server.recv_timeout(Duration::from_millis(100)).unwrap() else {
            continue;
        };
        let (ffmpeg, ffprobe, url, media, decoder, shutdown, remuxer, subtitles) = (
            ffmpeg.clone(),
            ffprobe.clone(),
            url.clone(),
            media.clone(),
            decoder.clone(),
            shutdown.clone(),
            remuxer.clone(),
            subtitles.clone(),
        );
        std::thread::spawn(move || {
            serve(
                request, &ffmpeg, &ffprobe, &url, &media, &decoder, &shutdown, &remuxer, &subtitles,
            )
        });
    }
    decoder.stop(None);
    remuxer.stop(None);
    subtitles.stop(None);
}

#[allow(clippy::too_many_arguments)]
fn serve(
    mut request: Request,
    ffmpeg: &std::path::Path,
    ffprobe: &std::path::Path,
    url: &str,
    media: &[u8],
    decoder: &media_audio::AudioDecoder,
    shutdown: &AtomicBool,
    remuxer: &media_audio::AudioDecoder,
    subtitles: &media_audio::AudioDecoder,
) {
    match request.url() {
        "/" => {
            let _ = request.respond(
                Response::from_string(
                    include_str!("../../scripts/media-webkit-test.html")
                        .replace("__MEDIA_URL_JSON__", &serde_json::to_string(url).unwrap())
                        .replace(
                            "/media.mp4",
                            if url.ends_with(".mkv") {
                                "/media.mkv"
                            } else {
                                "/media.mp4"
                            },
                        ),
                )
                .with_header(header("Content-Type", "text/html")),
            );
        }
        "/media-audio.js" => {
            let _ = request.respond(
                Response::from_string(include_str!("../module/media-audio.js"))
                    .with_header(header("Content-Type", "application/javascript")),
            );
        }
        "/media.mp4" | "/media.mkv" => {
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
            remuxer.stop(None);
            subtitles.stop(None);
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
                    "/api/media_audio_probe"
                        | "/api/media_audio_start"
                        | "/api/media_video_info"
                        | "/api/media_video_start"
                        | "/api/media_subtitle_tracks"
                        | "/api/media_subtitle_start"
                ) && input["url"] != url
                {
                    return Err("fixture URL required".into());
                }
                match route.as_str() {
                    "/api/media_subtitle_tracks" => Ok(serde_json::to_vec(
                        &media_audio::subtitle_tracks(ffprobe, url)?,
                    )
                    .unwrap()),
                    "/api/media_subtitle_start" => {
                        Ok(serde_json::to_vec(&subtitles.start_subtitles(
                            ffmpeg,
                            url,
                            input["stream"].as_u64().unwrap_or(0) as u32,
                            input["start"].as_f64().unwrap_or(0.0),
                        )?)
                        .unwrap())
                    }
                    "/api/media_subtitle_read" => subtitles.read(input["id"].as_u64().unwrap_or(0)),
                    "/api/media_subtitle_stop" => {
                        subtitles.stop(input["id"].as_u64());
                        Ok(b"null".to_vec())
                    }

                    "/api/media_video_info" => {
                        Ok(serde_json::to_vec(&media_audio::video_info(ffprobe, url)?).unwrap())
                    }
                    "/api/media_video_start" => {
                        let start = input["start"].as_f64().unwrap_or(0.0);
                        let offset = media_audio::video_offset(ffprobe, url, start)?;
                        let id = remuxer.start_video(ffmpeg, url, start)?;
                        Ok(serde_json::to_vec(&media_audio::VideoSession { id, offset }).unwrap())
                    }
                    "/api/media_video_keep_alive" => {
                        remuxer.keep_alive(input["id"].as_u64().unwrap_or(0))?;
                        Ok(b"null".to_vec())
                    }
                    "/api/media_video_read" => remuxer.read(input["id"].as_u64().unwrap_or(0)),
                    "/api/media_video_stop" => {
                        remuxer.stop(input["id"].as_u64());
                        Ok(b"null".to_vec())
                    }

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
