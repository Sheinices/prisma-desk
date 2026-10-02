// Prisma Desktop — десктопный клиент Prisma на Tauri.
// Copyright (C) 2026 Sheinices
// SPDX-License-Identifier: AGPL-3.0-only

//! Native FFmpeg PCM decoding and video stream copying over bounded binary IPC.
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

pub const SAMPLE_RATE: usize = 48_000;
const TIMEOUT: Duration = Duration::from_secs(30);
const PROTOCOLS: &str = "http,https,tcp,tls";
type Packet = Result<Vec<u8>, String>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrack {
    pub index: u32,
    pub codec: String,
    pub language: String,
    pub title: String,
    pub channels: u32,
    pub default: bool,
}

pub fn validate_url(url: &str) -> Result<(), String> {
    if url.len() > 8192 || url.chars().any(|c| c.is_control()) {
        return Err("Некорректный адрес медиапотока".into());
    }
    let parsed = tauri::Url::parse(url).map_err(|_| "Некорректный адрес медиапотока")?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("FFmpeg поддерживает только HTTP(S)-потоки".into());
    }
    Ok(())
}

pub fn executable(resource_dir: &Path, name: &str) -> Result<PathBuf, String> {
    let filename = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    let bundled = resource_dir.join("media-tools").join(&filename);
    if bundled.is_file() {
        return Ok(bundled);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sidecar = dir.join(format!("prisma-{filename}"));
            if sidecar.is_file() {
                return Ok(sidecar);
            }
            // cargo test binaries live in target/.../deps, one level below the
            // sidecars copied by tauri-build.
            #[cfg(test)]
            if let Some(parent) = dir.parent() {
                let sidecar = parent.join(format!("prisma-{filename}"));
                if sidecar.is_file() {
                    return Ok(sidecar);
                }
            }
        }
    }
    // Local development can use tools on PATH. Release builds use the pinned
    // tools included in resources, including in the portable archive.
    #[cfg(debug_assertions)]
    if let Ok(path) = which::which(&filename) {
        return Ok(path);
    }
    Err(format!(
        "{name} отсутствует в приложении. Выполните npm run prepare:media"
    ))
}

fn command(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
}

fn input_args(command: &mut Command, url: &str) {
    command.args([
        "-protocol_whitelist",
        PROTOCOLS,
        "-rw_timeout",
        "15000000",
        "-probesize",
        "2000000",
        "-analyzeduration",
        "2000000",
        // Only file containers. In particular, never follow playlists that
        // could reference local files or nested protocols.
        "-format_whitelist",
        "matroska,webm,mov,mpegts,mpeg,avi,flv,ogg",
        "-i",
        url,
    ]);
}

pub fn parse_tracks(bytes: &[u8]) -> Result<Vec<AudioTrack>, String> {
    parse_media_tracks(bytes, "audio")
}

fn parse_media_tracks(bytes: &[u8], kind: &str) -> Result<Vec<AudioTrack>, String> {
    let json: Value =
        serde_json::from_slice(bytes).map_err(|_| "Не удалось прочитать аудиодорожки")?;
    Ok(json["streams"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|stream| {
            if stream["codec_type"] != kind {
                return None;
            }
            Some(AudioTrack {
                index: u32::try_from(stream["index"].as_u64()?).ok()?,
                codec: stream["codec_name"].as_str().unwrap_or_default().into(),
                language: stream["tags"]["language"]
                    .as_str()
                    .unwrap_or_default()
                    .into(),
                title: stream["tags"]["title"].as_str().unwrap_or_default().into(),
                channels: stream["channels"].as_u64().unwrap_or(2) as u32,
                default: stream["disposition"]["default"].as_u64() == Some(1),
            })
        })
        .take(128)
        .collect())
}

type MetadataCache = Option<(String, Instant, Vec<u8>)>;

fn metadata(executable: &Path, url: &str) -> Result<Vec<u8>, String> {
    validate_url(url)?;
    // Audio, video and subtitle discovery share one network probe. TorrServer
    // should not have to service three concurrent metadata scans of the file.
    static CACHE: OnceLock<Mutex<MetadataCache>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(|| Mutex::new(None)).lock().unwrap();
    if let Some((cached_url, created, bytes)) = cache.as_ref() {
        if cached_url == url && created.elapsed() < TIMEOUT {
            return Ok(bytes.clone());
        }
    }
    let mut cmd = command(executable);
    cmd.args(["-v", "error"]);
    input_args(&mut cmd, url);
    cmd.args(["-show_entries",
        "stream=index,codec_type,codec_name,channels:stream_tags=language,title:stream_disposition=default:format=duration",
        "-of", "json"]);
    let bytes = probe_output(cmd)?;
    *cache = Some((url.to_string(), Instant::now(), bytes.clone()));
    Ok(bytes)
}

pub fn probe(executable: &Path, url: &str) -> Result<Vec<AudioTrack>, String> {
    parse_tracks(&metadata(executable, url)?)
}

#[derive(Serialize)]
pub struct VideoInfo {
    pub duration: f64,
    pub mime: String,
}

pub fn video_info(executable: &Path, url: &str) -> Result<VideoInfo, String> {
    let data: Value = serde_json::from_slice(&metadata(executable, url)?)
        .map_err(|_| "Ошибка метаданных видео")?;
    let video = data["streams"]
        .as_array()
        .and_then(|streams| {
            streams
                .iter()
                .find(|stream| stream["codec_type"] == "video")
        })
        .ok_or("Видеодорожка не найдена")?;
    if video["codec_name"] != "h264" {
        return Err("Перепаковка MKV пока поддерживает видео H.264".into());
    }
    let duration = data["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|d| d.is_finite() && *d > 0.0 && *d <= 604800.0)
        .ok_or("Не удалось определить длительность видео")?;
    Ok(VideoInfo {
        duration,
        mime: r#"video/mp4; codecs="avc1.640028""#.into(),
    })
}

#[derive(Serialize)]
pub struct VideoSession {
    pub id: u64,
    pub offset: f64,
}

pub fn video_offset(executable: &Path, url: &str, start: f64) -> Result<f64, String> {
    validate_url(url)?;
    if !start.is_finite() || !(0.0..=604800.0).contains(&start) {
        return Err("Некорректная позиция видео".into());
    }
    let mut cmd = command(executable);
    cmd.args(["-v", "error"]);
    input_args(&mut cmd, url);
    cmd.args([
        "-select_streams",
        "v:0",
        "-read_intervals",
        &if start > 0.0 {
            format!("{start}%+#32")
        } else {
            "%+#32".into()
        },
        "-show_packets",
        "-show_entries",
        "packet=dts_time,pts_time",
        "-of",
        "json",
    ]);
    let data: Value =
        serde_json::from_slice(&probe_output(cmd)?).map_err(|_| "Ошибка позиции видео")?;
    let packet = &data["packets"][0];
    packet["dts_time"]
        .as_str()
        .or_else(|| packet["pts_time"].as_str())
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .ok_or("Не удалось определить ключевой кадр видео".into())
}

pub fn subtitle_tracks(executable: &Path, url: &str) -> Result<Vec<AudioTrack>, String> {
    let mut tracks = parse_media_tracks(&metadata(executable, url)?, "subtitle")?;
    tracks.retain(|track| {
        matches!(
            track.codec.as_str(),
            "subrip" | "ass" | "ssa" | "webvtt" | "mov_text" | "text"
        )
    });
    Ok(tracks)
}

fn probe_output(mut cmd: Command) -> Result<Vec<u8>, String> {
    let mut child = cmd.spawn().map_err(|_| "Не удалось запустить ffprobe")?;
    let stdout = child.stdout.take().ok_or("Нет вывода ffprobe")?;
    let child = Arc::new(Mutex::new(child));
    let process = child.clone();
    let done = Arc::new(AtomicBool::new(false));
    let finished = done.clone();
    thread::spawn(move || {
        let deadline = Instant::now() + TIMEOUT;
        while !finished.load(Ordering::Relaxed) {
            if Instant::now() >= deadline {
                let _ = process.lock().unwrap().kill();
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
    });
    let mut bytes = Vec::new();
    let read = stdout.take(1024 * 1024 + 1).read_to_end(&mut bytes);
    done.store(true, Ordering::Relaxed);
    let mut child = child.lock().unwrap();
    if read.is_err() || bytes.len() > 1024 * 1024 {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Слишком большой ответ ffprobe".into());
    }
    if !child.wait().map_err(|_| "Ошибка ffprobe")?.success() {
        return Err("Не удалось определить аудиодорожки потока".into());
    }
    Ok(bytes)
}

struct DecodeJob {
    id: u64,
    child: Mutex<Child>,
    receiver: Mutex<Receiver<Packet>>,
    cancelled: AtomicBool,
    last_read: Mutex<Instant>,
}

impl DecodeJob {
    fn stop(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
        let mut child = self.child.lock().unwrap();
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn send_packet(sender: &SyncSender<Packet>, job: &DecodeJob, mut packet: Packet) -> bool {
    loop {
        if job.cancelled.load(Ordering::Relaxed) {
            return false;
        }
        match sender.try_send(packet) {
            Ok(()) => return true,
            Err(TrySendError::Disconnected(_)) => return false,
            Err(TrySendError::Full(value)) => packet = value,
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[derive(Default)]
pub struct AudioDecoder {
    active: Mutex<Option<Arc<DecodeJob>>>,
    sequence: AtomicU64,
}

impl AudioDecoder {
    pub fn start(
        &self,
        executable: &Path,
        url: &str,
        stream: u32,
        start: f64,
        channels: usize,
        rate: f64,
    ) -> Result<u64, String> {
        validate_url(url)?;
        if !start.is_finite()
            || !(0.0..=604800.0).contains(&start)
            || stream > 255
            || !matches!(channels, 1 | 2 | 4 | 6 | 8)
            || !rate.is_finite()
            || !(0.0625..=16.0).contains(&rate)
        {
            return Err("Некорректная дорожка или позиция аудио".into());
        }
        // Serialize replacement with stop/start, but never hold this lock while
        // waiting for PCM. A blocked network read must not prevent cancellation.
        let mut active = self.active.lock().unwrap();
        if let Some(previous) = active.take() {
            previous.stop();
        }
        let mut cmd = command(executable);
        cmd.args(["-nostdin", "-hide_banner", "-loglevel", "error"]);
        if start > 0.0 {
            cmd.args(["-ss", &start.to_string()]);
        }
        input_args(&mut cmd, url);
        // Preserve pitch when the video changes speed. Web Audio playbackRate
        // alone would change the pitch of voices as well as their tempo.
        let mut filters = vec!["aresample=48000:async=1:first_pts=0".to_string()];
        let mut tempo = rate;
        while tempo > 2.0 {
            filters.push("atempo=2".into());
            tempo /= 2.0;
        }
        while tempo < 0.5 {
            filters.push("atempo=0.5".into());
            tempo *= 2.0;
        }
        if (tempo - 1.0).abs() > f64::EPSILON {
            filters.push(format!("atempo={tempo}"));
        }
        cmd.args([
            "-map",
            &format!("0:{stream}"),
            "-vn",
            "-sn",
            "-dn",
            "-af",
            &filters.join(","),
            "-ac",
            &channels.to_string(),
            "-channel_layout",
            match channels {
                1 => "mono",
                2 => "stereo",
                4 => "quad",
                6 => "5.1",
                _ => "7.1",
            },
            "-ar",
            "48000",
            "-c:a",
            "pcm_f32le",
            "-f",
            "f32le",
            "pipe:1",
        ]);
        self.launch(
            cmd,
            &mut active,
            SAMPLE_RATE * channels * 4 / 2,
            channels * 4,
            true,
        )
    }

    pub fn start_video(&self, executable: &Path, url: &str, start: f64) -> Result<u64, String> {
        validate_url(url)?;
        if !start.is_finite() || !(0.0..=604800.0).contains(&start) {
            return Err("Некорректная позиция видео".into());
        }
        let mut active = self.active.lock().unwrap();
        if let Some(previous) = active.take() {
            previous.stop();
        }
        let mut cmd = command(executable);
        cmd.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-copyts"]);
        if start > 0.0 {
            cmd.args(["-ss", &start.to_string()]);
        }
        input_args(&mut cmd, url);
        cmd.args([
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-c:v",
            "copy",
            "-movflags",
            "frag_keyframe+empty_moov+default_base_moof",
            "-frag_duration",
            "1000000",
            "-avoid_negative_ts",
            "disabled",
            "-f",
            "mp4",
            "pipe:1",
        ]);
        self.launch(cmd, &mut active, 256 * 1024, 1, false)
    }

    pub fn start_subtitles(
        &self,
        executable: &Path,
        url: &str,
        stream: u32,
        start: f64,
    ) -> Result<u64, String> {
        validate_url(url)?;
        if stream > 255 || !start.is_finite() || !(0.0..=604800.0).contains(&start) {
            return Err("Некорректная дорожка или позиция субтитров".into());
        }
        let mut active = self.active.lock().unwrap();
        if let Some(previous) = active.take() {
            previous.stop();
        }
        let mut cmd = command(executable);
        cmd.args(["-nostdin", "-hide_banner", "-loglevel", "error"]);
        // Matroska's explicit seek to zero can skip the first subtitle packet.
        // Reading from the beginning avoids losing the opening cue.
        if start > 0.0 {
            cmd.args(["-ss", &start.to_string()]);
        }
        input_args(&mut cmd, url);
        cmd.args([
            "-map",
            &format!("0:{stream}"),
            "-vn",
            "-an",
            "-dn",
            "-t",
            "120",
            "-c:s",
            "webvtt",
            "-f",
            "webvtt",
            "-flush_packets",
            "1",
            "pipe:1",
        ]);
        self.launch(cmd, &mut active, 64 * 1024, 1, false)
    }

    fn launch(
        &self,
        mut cmd: Command,
        active: &mut Option<Arc<DecodeJob>>,
        packet_bytes: usize,
        alignment: usize,
        full_packets: bool,
    ) -> Result<u64, String> {
        let mut child = cmd.spawn().map_err(|_| "Не удалось запустить FFmpeg")?;
        let mut stdout = child.stdout.take().ok_or("Нет вывода FFmpeg")?;
        // Eight seconds of decoded audio, irrespective of movie length.
        let (tx, rx) = mpsc::sync_channel(16);
        let id = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let job = Arc::new(DecodeJob {
            id,
            child: Mutex::new(child),
            receiver: Mutex::new(rx),
            cancelled: AtomicBool::new(false),
            last_read: Mutex::new(Instant::now()),
        });
        let reader_job = job.clone();
        thread::spawn(move || loop {
            let mut bytes = vec![0; packet_bytes];
            let mut count = 0;
            while count < bytes.len() {
                match stdout.read(&mut bytes[count..]) {
                    Ok(0) => break,
                    Ok(n) => {
                        count += n;
                        if !full_packets {
                            break;
                        }
                    }
                    Err(_) => {
                        send_packet(&tx, &reader_job, Err("Ошибка чтения FFmpeg".into()));
                        reader_job.stop();
                        return;
                    }
                }
            }
            if count > 0 {
                bytes.truncate(count - count % alignment);
                if !send_packet(&tx, &reader_job, Ok(bytes)) {
                    break;
                }
            }
            if count == 0 || full_packets && count < packet_bytes {
                let success = reader_job
                    .child
                    .lock()
                    .unwrap()
                    .wait()
                    .is_ok_and(|s| s.success());
                if !success && !reader_job.cancelled.load(Ordering::Relaxed) {
                    send_packet(
                        &tx,
                        &reader_job,
                        Err("FFmpeg не смог обработать дорожку".into()),
                    );
                }
                break;
            }
        });
        let watcher = job.clone();
        thread::spawn(move || {
            while !watcher.cancelled.load(Ordering::Relaxed) {
                if watcher.last_read.lock().unwrap().elapsed() > TIMEOUT {
                    watcher.stop();
                    break;
                }
                thread::sleep(Duration::from_millis(200));
            }
        });
        *active = Some(job);
        Ok(id)
    }

    pub fn keep_alive(&self, id: u64) -> Result<(), String> {
        let active = self.active.lock().unwrap();
        let job = active
            .as_ref()
            .filter(|j| j.id == id && !j.cancelled.load(Ordering::Relaxed))
            .ok_or("Медиасессия завершена")?;
        *job.last_read.lock().unwrap() = Instant::now();
        Ok(())
    }

    pub fn read(&self, id: u64) -> Result<Vec<u8>, String> {
        let job = self
            .active
            .lock()
            .unwrap()
            .as_ref()
            .filter(|j| j.id == id)
            .cloned()
            .ok_or("Медиасессия завершена")?;
        *job.last_read.lock().unwrap() = Instant::now();
        let received = job.receiver.lock().unwrap().recv_timeout(TIMEOUT);
        if job.cancelled.load(Ordering::Relaxed) {
            return Err("Медиасессия завершена".into());
        }
        match received {
            Ok(packet) => packet,
            Err(mpsc::RecvTimeoutError::Disconnected) => Ok(Vec::new()),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                job.stop();
                Err("Истекло время ожидания FFmpeg".into())
            }
        }
    }

    pub fn stop(&self, id: Option<u64>) {
        let mut active = self.active.lock().unwrap();
        if active
            .as_ref()
            .is_some_and(|job| id.is_none() || id == Some(job.id))
        {
            if let Some(job) = active.take() {
                job.stop();
            }
        }
    }
}

impl Drop for AudioDecoder {
    fn drop(&mut self) {
        self.stop(None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_local_files_and_nested_protocols() {
        for url in [
            "file:///etc/passwd",
            "concat:http://host/a|file:/secret",
            "http://host/a\n",
            "data:audio/ac3,foo",
            "-i",
            "",
        ] {
            assert!(validate_url(url).is_err(), "{url}");
        }
        assert!(validate_url("http://127.0.0.1:8090/stream?play&index=1").is_ok());
        assert!(validate_url("https://host/movie.mkv?token=foo").is_ok());
    }

    #[test]
    fn preserves_container_stream_indices_and_track_metadata() {
        let tracks = parse_tracks(br#"{"streams":[{"index":0,"codec_type":"video"},{"index":2,"codec_type":"audio","codec_name":"eac3","channels":6,"tags":{"language":"rus","title":"Dub"},"disposition":{"default":1}},{"index":5,"codec_type":"audio","codec_name":"ac3"}]}"#).unwrap();
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].index, 2);
        assert_eq!(tracks[0].channels, 6);
        assert_eq!(tracks[0].language, "rus");
        assert!(tracks[0].default);
        assert_eq!(tracks[1].index, 5);
    }

    #[test]
    #[ignore = "requires pinned media tools; run npm run prepare:media first"]
    fn decodes_ac3_eac3_over_http_and_seeks_without_aac() {
        use tiny_http::{Header, Response, Server};
        let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        let ffmpeg = executable(&resources, "ffmpeg").unwrap();
        let ffprobe = executable(&resources, "ffprobe").unwrap();
        let fixture = std::env::temp_dir().join(format!("prisma-audio-{}.mkv", std::process::id()));
        let subtitles =
            std::env::temp_dir().join(format!("prisma-audio-{}.srt", std::process::id()));
        std::fs::write(&subtitles, "1\n00:00:00,500 --> 00:00:02,000\nПривет\n\n2\n00:00:03,000 --> 00:00:05,000\nПосле перемотки\n").unwrap();
        let status = command(&ffmpeg)
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=64x64:r=10:d=6",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=6",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=880:sample_rate=48000:duration=6",
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
                "srt",
                "-c:v",
                "libx264",
                "-g",
                "10",
                "-c:a:0",
                "ac3",
                "-c:a:1",
                "eac3",
                "-ac:a:1",
                "6",
                "-metadata:s:a:0",
                "language=rus",
                "-metadata:s:a:1",
                "language=eng",
                "-disposition:a:0",
                "default",
                "-disposition:a:1",
                "0",
            ])
            .arg(&fixture)
            .status()
            .unwrap();
        assert!(status.success());
        let bytes = std::fs::read(&fixture).unwrap();
        std::fs::remove_file(&fixture).unwrap();
        std::fs::remove_file(&subtitles).unwrap();
        let server = Server::http(("127.0.0.1", 0)).unwrap();
        let url = format!("http://{}/movie.mkv", server.server_addr());
        let shutdown = Arc::new(AtomicBool::new(false));
        let stop = shutdown.clone();
        let worker = thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let Some(request) = server.recv_timeout(Duration::from_millis(100)).unwrap() else {
                    continue;
                };
                if request.url() == "/stall" {
                    thread::sleep(Duration::from_millis(500));
                }
                let range = request
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Range"))
                    .and_then(|h| h.value.as_str().strip_prefix("bytes="))
                    .and_then(|r| r.split_once('-'))
                    .and_then(|(start, _)| start.parse::<usize>().ok());
                let start = range.unwrap_or(0).min(bytes.len());
                let mut response = Response::from_data(bytes[start..].to_vec())
                    .with_header(Header::from_bytes("Accept-Ranges", "bytes").unwrap());
                if range.is_some() {
                    response = response.with_status_code(206).with_header(
                        Header::from_bytes(
                            "Content-Range",
                            format!("bytes {start}-{}/{}", bytes.len() - 1, bytes.len()),
                        )
                        .unwrap(),
                    );
                }
                let _ = request.respond(response);
            }
        });

        let video = video_info(&ffprobe, &url).unwrap();
        assert!((video.duration - 6.0).abs() < 0.1);
        let opening_dts = video_offset(&ffprobe, &url, 0.0).unwrap();
        assert!(
            (-0.3..0.05).contains(&opening_dts),
            "opening DTS: {opening_dts}"
        );
        let keyframe = video_offset(&ffprobe, &url, 2.375).unwrap();
        assert!(
            (1.7..=2.375).contains(&keyframe),
            "keyframe DTS: {keyframe}"
        );
        let subtitle_tracks = subtitle_tracks(&ffprobe, &url).unwrap();
        assert_eq!(subtitle_tracks.len(), 1);
        assert_eq!(subtitle_tracks[0].index, 3);
        let subtitles = AudioDecoder::default();
        let initial = subtitles.start_subtitles(&ffmpeg, &url, 3, 0.0).unwrap();
        let mut opening = Vec::new();
        loop {
            let chunk = subtitles.read(initial).unwrap();
            if chunk.is_empty() {
                break;
            }
            opening.extend(chunk);
        }
        assert!(String::from_utf8(opening).unwrap().contains("Привет"));
        let id = subtitles.start_subtitles(&ffmpeg, &url, 3, 2.5).unwrap();
        let mut vtt = Vec::new();
        loop {
            let chunk = subtitles.read(id).unwrap();
            if chunk.is_empty() {
                break;
            }
            vtt.extend(chunk);
        }
        let text = String::from_utf8(vtt).unwrap();
        assert!(text.starts_with("WEBVTT"));
        assert!(text.contains("После перемотки"));
        let timing = text.lines().find(|line| line.contains(" --> ")).unwrap();
        let begin: f64 = timing
            .split_whitespace()
            .next()
            .unwrap()
            .rsplit(':')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        assert!(
            (begin - 0.5).abs() < 0.02,
            "relative cue timestamps: {text}"
        );
        subtitles.stop(None);

        let tracks = probe(&ffprobe, &url).unwrap();
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].codec, "ac3");
        assert_eq!(tracks[1].codec, "eac3");
        assert_eq!(tracks[1].channels, 6);
        assert_eq!(tracks[0].language, "rus");
        let decoder = AudioDecoder::default();
        let id = decoder
            .start(&ffmpeg, &url, tracks[0].index, 0.0, 2, 1.0)
            .unwrap();
        let mut reference = Vec::new();
        loop {
            let packet = decoder.read(id).unwrap();
            if packet.is_empty() {
                break;
            }
            reference.extend(packet);
        }
        assert!(reference.len() >= SAMPLE_RATE * 2 * 4 * 6);

        let position = 2.375;
        let next = decoder
            .start(&ffmpeg, &url, tracks[0].index, position, 2, 1.0)
            .unwrap();
        decoder.stop(Some(id)); // A retired frontend must not stop the new session.
        let sought = decoder.read(next).unwrap();
        let offset = (position * SAMPLE_RATE as f64) as usize * 2 * 4;
        let reference = &reference[offset..offset + sought.len()];
        let mse: f64 = reference
            .chunks_exact(4)
            .zip(sought.chunks_exact(4))
            .map(|(a, b)| {
                let delta = f32::from_le_bytes(a.try_into().unwrap())
                    - f32::from_le_bytes(b.try_into().unwrap());
                (delta as f64).powi(2)
            })
            .sum::<f64>()
            / (sought.len() / 4) as f64;
        assert!(mse.sqrt() < 0.001, "seek PCM RMS error: {}", mse.sqrt());

        fn crossings(pcm: &[u8], channels: usize, channel: usize) -> usize {
            let samples: Vec<_> = pcm
                .chunks_exact(channels * 4)
                .map(|p| f32::from_le_bytes(p[channel * 4..channel * 4 + 4].try_into().unwrap()))
                .collect();
            samples
                .windows(2)
                .filter(|pair| (pair[0] > 0.0) != (pair[1] > 0.0))
                .count()
        }
        assert!((430..450).contains(&crossings(&sought, 2, 0)));
        let eac3 = decoder
            .start(&ffmpeg, &url, tracks[1].index, position, 6, 1.0)
            .unwrap();
        let packet = decoder.read(eac3).unwrap();
        assert_eq!(packet.len(), SAMPLE_RATE * 6 * 4 / 2);
        assert!((870..890).contains(&crossings(&packet, 6, 2)));
        let faster = decoder
            .start(&ffmpeg, &url, tracks[1].index, position, 6, 1.5)
            .unwrap();
        let packet = decoder.read(faster).unwrap();
        assert!(
            (870..890).contains(&crossings(&packet, 6, 2)),
            "tempo must preserve pitch"
        );
        let before = Instant::now();
        decoder.stop(None);
        assert!(before.elapsed() < Duration::from_secs(1));
        assert!(decoder.read(eac3).is_err());

        // Cancellation must work even when the reader is blocked waiting for
        // an HTTP response. It must not wait for the 30s PCM read timeout.
        let decoder = Arc::new(decoder);
        let stalled = decoder
            .start(
                &ffmpeg,
                &url.replace("/movie.mkv", "/stall"),
                tracks[0].index,
                0.0,
                2,
                1.0,
            )
            .unwrap();
        let pending = decoder.clone();
        let read = thread::spawn(move || pending.read(stalled));
        thread::sleep(Duration::from_millis(50));
        let before = Instant::now();
        decoder.stop(Some(stalled));
        let _ = read.join().unwrap();
        assert!(before.elapsed() < Duration::from_secs(1));
        shutdown.store(true, Ordering::Relaxed);
        worker.join().unwrap();
    }
}
