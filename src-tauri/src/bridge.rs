use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::Emitter;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use crate::config::BridgeConfig;

pub enum BridgeCommand {
    SendText(String),
    SendFile(String),
    Stop,
}

pub struct BridgeClient {
    tx: mpsc::Sender<BridgeCommand>,
    connected: Arc<AtomicBool>,
}

static CLIENT_SEQ: AtomicU64 = AtomicU64::new(1);

enum SendLoopExit {
    Stopped,
    Disconnected,
}

impl BridgeClient {
    pub fn start(cfg: BridgeConfig, app: tauri::AppHandle) -> Self {
        let (tx, rx) = mpsc::channel::<BridgeCommand>(64);
        let rx = Arc::new(Mutex::new(rx));
        let client_id = CLIENT_SEQ.fetch_add(1, Ordering::Relaxed);
        let connected = Arc::new(AtomicBool::new(false));
        let connected_for_loop = connected.clone();

        tokio::spawn(async move {
            bridge_loop(cfg, app, rx, client_id, connected_for_loop).await;
        });

        Self { tx, connected }
    }

    pub async fn send_text(&self, text: String) -> Result<(), String> {
        self.tx
            .send(BridgeCommand::SendText(text))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn send_file(&self, path: String) -> Result<(), String> {
        self.tx
            .send(BridgeCommand::SendFile(path))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn stop(&self) {
        let _ = self.tx.send(BridgeCommand::Stop).await;
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }
}

fn build_ws_url(cfg: &BridgeConfig) -> String {
    let host = normalize_host(&cfg.host);
    let encoded_token = percent_encode(cfg.token.as_bytes());
    format!(
        "ws://{}:{}/bridge/ws?token={}",
        host, cfg.port, encoded_token
    )
}

fn normalize_host(host: &str) -> String {
    let h = host.trim();
    let parts: Vec<&str> = h.split('.').collect();
    if parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
    {
        let a = parts[0].parse::<u8>();
        let b = parts[1].parse::<u8>();
        let c = parts[2].parse::<u8>();
        if let (Ok(a), Ok(b), Ok(c)) = (a, b, c) {
            return format!("{a}.{b}.0.{c}");
        }
    }
    h.to_string()
}

fn percent_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for &b in input {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push(char::from(b"0123456789ABCDEF"[(b >> 4) as usize]));
                out.push(char::from(b"0123456789ABCDEF"[(b & 0x0f) as usize]));
            }
        }
    }
    out
}

fn make_register(platform: &str) -> String {
    json!({
        "type": "register",
        "platform": platform,
        "capabilities": ["text", "buttons"],
        "metadata": {
            "version": "0.4.0",
            "protocol_version": 1,
            "description": "CC Pet desktop (Tauri)"
        }
    })
    .to_string()
}

fn make_message(text: &str, cfg: &BridgeConfig) -> String {
    let session_key = format!("{}:{}:{}", cfg.platform_name, cfg.user_id, cfg.user_id);
    json!({
        "type": "message",
        "msg_id": format!("pet-{}", uuid::Uuid::new_v4().to_string()[..8].to_string()),
        "session_key": session_key,
        "user_id": cfg.user_id,
        "user_name": "Desktop Pet",
        "content": text,
        "reply_ctx": format!("ctx-{}", cfg.user_id),
    })
    .to_string()
}

fn make_file_message(path: &str, cfg: &BridgeConfig) -> Result<String, String> {
    let file_path = std::path::Path::new(path);
    let data = std::fs::read(file_path).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    let name = file_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let session_key = format!("{}:{}:{}", cfg.platform_name, cfg.user_id, cfg.user_id);
    Ok(json!({
        "type": "message",
        "msg_id": format!("pet-file-{}", uuid::Uuid::new_v4().to_string()[..8].to_string()),
        "session_key": session_key,
        "user_id": cfg.user_id,
        "user_name": "Desktop Pet",
        "content": format!("[文件: {}]", name),
        "reply_ctx": format!("ctx-{}", cfg.user_id),
        "attachments": [{"type": "file", "name": name, "data": b64}],
    })
    .to_string())
}

fn make_ping() -> String {
    json!({
        "type": "ping",
        "ts": chrono::Utc::now().timestamp_millis(),
    })
    .to_string()
}

/// Extract incremental text from a `reply_stream` frame (when `done` is false).
/// Matches cc-connect / selftest: `delta`, `text`, or string `content`.
fn reply_stream_chunk(val: &Value) -> Option<String> {
    if let Some(d) = val.get("delta") {
        if let Some(s) = d.as_str() {
            return Some(s.to_string());
        }
        if let Some(s) = d.get("content").and_then(|v| v.as_str()) {
            return Some(s.to_string());
        }
    }
    if let Some(s) = val.get("chunk").and_then(|v| v.as_str()) {
        return Some(s.to_string());
    }
    if let Some(data) = val.get("data") {
        if let Some(s) = data.get("delta").and_then(|v| v.as_str()) {
            return Some(s.to_string());
        }
        if let Some(s) = data.get("content").and_then(|v| v.as_str()) {
            return Some(s.to_string());
        }
        if let Some(s) = data.get("text").and_then(|v| v.as_str()) {
            return Some(s.to_string());
        }
        if let Some(delta_obj) = data.get("delta") {
            if let Some(s) = delta_obj.get("content").and_then(|v| v.as_str()) {
                return Some(s.to_string());
            }
        }
    }
    val.get("text")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| val.get("content").and_then(|v| v.as_str()).map(|s| s.to_string()))
}

async fn bridge_loop(
    cfg: BridgeConfig,
    app: tauri::AppHandle,
    rx: Arc<Mutex<mpsc::Receiver<BridgeCommand>>>,
    client_id: u64,
    connected: Arc<AtomicBool>,
) {
    let mut backoff = 1u64;

    loop {
        let url_str = build_ws_url(&cfg);
        eprintln!("[bridge:{client_id}] connecting to {}", url_str);

        match connect_async(&url_str).await {
            Ok((ws, _)) => {
                eprintln!("[bridge:{client_id}] connected");
                connected.store(false, Ordering::Relaxed);
                backoff = 1;
                let (mut write, mut read) = ws.split();

                // register
                if let Err(e) = write.send(Message::Text(make_register(&cfg.platform_name).into())).await {
                    eprintln!("[bridge:{client_id}] register send failed: {e}");
                    let _ = app.emit("bridge-error", format!("Register failed: {e}"));
                    continue;
                }
                eprintln!("[bridge:{client_id}] register sent");

                let app2 = app.clone();
                let cfg2 = cfg.clone();
                let rx2 = rx.clone();

                // send loop
                let send_handle = tokio::spawn(async move {
                    let mut rx = rx2.lock().await;
                    loop {
                        tokio::select! {
                            cmd = rx.recv() => {
                                match cmd {
                                    Some(BridgeCommand::SendText(text)) => {
                                        let msg = make_message(&text, &cfg2);
                                        eprintln!("[bridge:{client_id}] sending text frame, bytes={}", msg.len());
                                        if write.send(Message::Text(msg.into())).await.is_err() {
                                            eprintln!("[bridge:{client_id}] send text failed; disconnected");
                                            return SendLoopExit::Disconnected;
                                        }
                                        eprintln!("[bridge:{client_id}] text frame sent");
                                    }
                                    Some(BridgeCommand::SendFile(path)) => {
                                        match make_file_message(&path, &cfg2) {
                                            Ok(msg) => {
                                                if write.send(Message::Text(msg.into())).await.is_err() {
                                                    eprintln!("[bridge:{client_id}] send file failed; disconnected");
                                                    return SendLoopExit::Disconnected;
                                                }
                                            }
                                            Err(e) => {
                                                let _ = app2.emit("bridge-error", format!("File send failed: {e}"));
                                            }
                                        }
                                    }
                                    Some(BridgeCommand::Stop) | None => {
                                        eprintln!("[bridge:{client_id}] stop received");
                                        return SendLoopExit::Stopped;
                                    }
                                }
                            }
                            _ = tokio::time::sleep(tokio::time::Duration::from_secs(25)) => {
                                if write.send(Message::Text(make_ping().into())).await.is_err() {
                                    eprintln!("[bridge:{client_id}] ping failed; disconnected");
                                    return SendLoopExit::Disconnected;
                                }
                            }
                        }
                    }
                });

                // recv loop
                let app3 = app.clone();
                let connected_for_recv = connected.clone();
                let recv_handle = tokio::spawn(async move {
                    while let Some(Ok(msg)) = read.next().await {
                        if let Message::Text(text) = msg {
                            let preview: String = text.chars().take(200).collect();
                            eprintln!("[bridge:{client_id}] recv text: {}", preview);
                            if let Ok(val) = serde_json::from_str::<Value>(&text) {
                                if val.get("type").and_then(|v| v.as_str()) == Some("register_ack")
                                    && val.get("ok").and_then(|v| v.as_bool()).unwrap_or(false)
                                {
                                    connected_for_recv.store(true, Ordering::Relaxed);
                                }
                                handle_message(&val, &app3);
                            }
                        }
                    }
                    eprintln!("[bridge:{client_id}] receiver closed");
                });

                let should_reconnect = tokio::select! {
                    result = send_handle => {
                        let reconnect = matches!(result.ok(), Some(SendLoopExit::Disconnected));
                        eprintln!("[bridge:{client_id}] sender ended; reconnect={reconnect}");
                        reconnect
                    }
                    _ = recv_handle => {
                        eprintln!("[bridge:{client_id}] receiver task ended; reconnect=true");
                        true
                    }
                };

                connected.store(false, Ordering::Relaxed);
                let _ = app.emit("bridge-connected", false);
                if !should_reconnect {
                    eprintln!("[bridge:{client_id}] stopped by request; exiting loop");
                    return;
                }
            }
            Err(e) => {
                eprintln!("[bridge:{client_id}] connect failed: {e}");
                connected.store(false, Ordering::Relaxed);
                let _ = app.emit("bridge-error", format!("Connection failed: {e}"));
                let _ = app.emit("bridge-connected", false);
            }
        }

        eprintln!("[bridge:{client_id}] reconnect in {}s", backoff.min(60));
        tokio::time::sleep(tokio::time::Duration::from_secs(backoff.min(60))).await;
        backoff = (backoff * 2).min(60);
    }
}

fn handle_message(val: &Value, app: &tauri::AppHandle) {
    let msg_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match msg_type {
        "register_ack" => {
            if val.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                eprintln!("[bridge] register_ack ok");
                let _ = app.emit("bridge-connected", true);
            } else {
                let err = val
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                eprintln!("[bridge] register_ack rejected: {err}");
                let _ = app.emit("bridge-error", format!("Registration rejected: {err}"));
            }
        }
        "reply" => {
            if let Some(content) = val
                .get("content")
                .and_then(|v| v.as_str())
                .or_else(|| val.get("text").and_then(|v| v.as_str()))
                .or_else(|| val.get("message").and_then(|v| v.as_str()))
            {
                if !content.is_empty() {
                    let _ = app.emit("bridge-message", content.to_string());
                }
            }
        }
        "reply_stream" => {
            let done = val.get("done").and_then(|v| v.as_bool()).unwrap_or(false);
            if done {
                let full = val
                    .get("full_text")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .or_else(|| val.get("full").and_then(|v| v.as_str()).map(|s| s.to_string()))
                    .or_else(|| val.get("text").and_then(|v| v.as_str()).map(|s| s.to_string()))
                    .or_else(|| {
                        val.get("content")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    });
                if let Some(text) = full.filter(|s| !s.is_empty()) {
                    eprintln!("[bridge] emit bridge-stream-done len={}", text.len());
                    let _ = app.emit("bridge-stream-done", text);
                } else {
                    eprintln!("[bridge] emit bridge-stream-done empty");
                    let _ = app.emit("bridge-stream-done", String::new());
                }
            } else if let Some(chunk) = reply_stream_chunk(val) {
                if !chunk.is_empty() {
                    eprintln!("[bridge] emit bridge-stream-delta len={}", chunk.len());
                    let _ = app.emit("bridge-stream-delta", chunk);
                }
            }
        }
        "buttons" => {
            if let Some(content) = val.get("content").and_then(|v| v.as_str()) {
                if !content.is_empty() {
                    eprintln!("[bridge] emit bridge-message(buttons) len={}", content.len());
                    let _ = app.emit("bridge-message", content.to_string());
                }
            }
        }
        "error" => {
            let msg = val
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Bridge error");
            let _ = app.emit("bridge-error", msg.to_string());
        }
        other => {
            eprintln!("[bridge] ignored message type={}", other);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_cfg() -> BridgeConfig {
        BridgeConfig {
            host: "127.0.0.1".to_string(),
            port: 9810,
            token: "test-token:&$".to_string(),
            platform_name: "desktop-pet".to_string(),
            user_id: "pet-user".to_string(),
        }
    }

    #[test]
    fn ws_url_encodes_token() {
        let url = build_ws_url(&test_cfg());
        assert_eq!(
            url,
            "ws://127.0.0.1:9810/bridge/ws?token=test-token%3A%26%24"
        );
    }

    #[test]
    fn normalize_three_segment_ipv4() {
        assert_eq!(normalize_host("127.0.01"), "127.0.0.1");
        assert_eq!(normalize_host("127.0.1"), "127.0.0.1");
        assert_eq!(normalize_host("localhost"), "localhost");
    }

    #[test]
    fn register_payload_has_required_fields() {
        let v: Value = serde_json::from_str(&make_register("desktop-pet")).unwrap();
        assert_eq!(v["type"], "register");
        assert_eq!(v["platform"], "desktop-pet");
    }

    #[test]
    fn message_payload_has_session_key() {
        let v: Value = serde_json::from_str(&make_message("hello", &test_cfg())).unwrap();
        assert_eq!(v["type"], "message");
        assert_eq!(v["content"], "hello");
        assert_eq!(v["session_key"], "desktop-pet:pet-user:pet-user");
    }
}
