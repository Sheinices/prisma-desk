use std::io::Read;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tiny_http::{Header, Method, Response, Server, StatusCode};

#[derive(Debug)]
pub struct ProxyServerManager {
    running: bool,
    shutdown_tx: Option<Sender<()>>,
    worker: Option<JoinHandle<()>>,
}

impl Default for ProxyServerManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ProxyServerManager {
    pub fn new() -> Self {
        Self {
            running: false,
            shutdown_tx: None,
            worker: None,
        }
    }

    pub fn start(&mut self) -> Result<(), String> {
        if self.running {
            return Ok(());
        }

        let server = Server::http("127.0.0.1:4000")
            .map_err(|e| format!("failed to start proxy on 127.0.0.1:4000: {e}"))?;

        let (tx, rx) = mpsc::channel::<()>();

        let worker = thread::spawn(move || run_proxy_loop(server, rx));

        self.shutdown_tx = Some(tx);
        self.worker = Some(worker);
        self.running = true;
        Ok(())
    }

    pub fn stop(&mut self) {
        if !self.running {
            return;
        }

        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }

        if let Some(handle) = self.worker.take() {
            let _ = handle.join();
        }

        self.running = false;
    }
}

fn run_proxy_loop(server: Server, shutdown_rx: Receiver<()>) {
    let client = reqwest::blocking::Client::new();

    loop {
        if shutdown_rx.try_recv().is_ok() {
            break;
        }

        let request_opt = match server.recv_timeout(Duration::from_millis(200)) {
            Ok(req) => req,
            Err(_) => continue,
        };

        let Some(mut request) = request_opt else {
            continue;
        };

        let url = request.url().to_string();

        if !url.starts_with("/vlc") {
            let response = Response::from_string("Not Found. Use /vlc path for VLC proxy.")
                .with_status_code(StatusCode(404));
            let _ = request.respond(response);
            continue;
        }

        if request.method() == &Method::Options {
            let response = with_cors(Response::empty(200));
            let _ = request.respond(response);
            continue;
        }

        let target_path = if url == "/vlc" {
            "/".to_string()
        } else {
            url.replacen("/vlc", "", 1)
        };

        let target_url = format!("http://127.0.0.1:3999{target_path}");

        let method = reqwest::Method::from_bytes(request.method().as_str().as_bytes())
            .unwrap_or(reqwest::Method::GET);

        let mut body = Vec::new();
        let _ = request.as_reader().read_to_end(&mut body);

        let mut proxied = client.request(method, &target_url);
        if !body.is_empty() {
            proxied = proxied.body(body);
        }

        let response = match proxied.send() {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let content_type = resp
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .map(|v| v.to_string());

                let bytes = resp.bytes().map(|b| b.to_vec()).unwrap_or_default();
                let mut out = Response::from_data(bytes).with_status_code(StatusCode(status));

                if let Some(content_type) = content_type {
                    if let Ok(header) = Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()) {
                        out = out.with_header(header);
                    }
                }

                with_cors(out)
            }
            Err(err) => with_cors(
                Response::from_string(format!("Proxy error: {err}"))
                    .with_status_code(StatusCode(502)),
            ),
        };

        let _ = request.respond(response);
    }
}

fn with_cors<R: Read + Send + 'static>(mut response: Response<R>) -> Response<R> {
    if let Ok(header) = Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]) {
        response.add_header(header);
    }
    if let Ok(header) = Header::from_bytes(
        &b"Access-Control-Allow-Methods"[..],
        &b"GET, POST, OPTIONS"[..],
    ) {
        response.add_header(header);
    }
    if let Ok(header) = Header::from_bytes(
        &b"Access-Control-Allow-Headers"[..],
        &b"Content-Type, Authorization"[..],
    ) {
        response.add_header(header);
    }

    response
}
