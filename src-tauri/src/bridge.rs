use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::Emitter;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use crate::config::BridgeConfig;
use crate::history::{ChatHistory, ChatMessage};

pub enum BridgeCommand {
    SendText {
        text: String,
        session_key: Option<String>,
        reply_ctx: Option<String>,
    },
    SendFile {
        path: String,
        session_key: Option<String>,
        reply_ctx: Option<String>,
    },
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
    pub fn start(connection_id: String, cfg: BridgeConfig, app: tauri::AppHandle, history: ChatHistory) -> Self {
        let (tx, rx) = mpsc::channel::<BridgeCommand>(64);
        let rx = Arc::new(Mutex::new(rx));
        let client_id = CLIENT_SEQ.fetch_add(1, Ordering::Relaxed);
        let connected = Arc::new(AtomicBool::new(false));
        let connected_for_loop = connected.clone();

        tokio::spawn(async move {
            bridge_loop(connection_id, cfg, app, rx, client_id, connected_for_loop, history).await;
        });

        Self { tx, connected }
    }

    pub async fn send_text(
        &self,
        text: String,
        session_key: Option<String>,
        reply_ctx: Option<String>,
    ) -> Result<(), String> {
        self.tx
            .send(BridgeCommand::SendText {
                text,
                session_key,
                reply_ctx,
            })
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn send_file(
        &self,
        path: String,
        session_key: Option<String>,
        reply_ctx: Option<String>,
    ) -> Result<(), String> {
        self.tx
            .send(BridgeCommand::SendFile {
                path,
                session_key,
                reply_ctx,
            })
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
        "capabilities": ["text", "buttons", "file"],
        "metadata": {
            "version": "0.5.0",
            "protocol_version": 1,
            "description": "CC Pet desktop (Tauri)"
        }
    })
    .to_string()
}

fn downloads_dir() -> std::path::PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let dir = home.join(".cc-pet").join("downloads");
    std::fs::create_dir_all(&dir).ok();
    dir
}

fn sanitize_filename(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            _ => c,
        })
        .collect();
    let trimmed = sanitized.trim().trim_matches('.');
    if trimmed.is_empty() {
        "file".into()
    } else {
        trimmed.to_string()
    }
}

fn save_attachment(attachment: &Value) -> Option<(String, String)> {
    let raw_name = attachment
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("file");
    let safe_name = sanitize_filename(raw_name);

    let data_str = attachment.get("data").and_then(|v| v.as_str())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_str)
        .ok()?;

    let dir = downloads_dir();
    let mut path = dir.join(&safe_name);

    if path.exists() {
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let ext = path
            .extension()
            .map(|s| format!(".{}", s.to_string_lossy()))
            .unwrap_or_default();
        let ts = chrono::Utc::now().timestamp_millis();
        path = dir.join(format!("{}_{}{}", stem, ts, ext));
    }

    std::fs::write(&path, &bytes).ok()?;
    eprintln!(
        "[bridge] saved attachment: {} ({} bytes) -> {}",
        safe_name,
        bytes.len(),
        path.display()
    );
    Some((safe_name, path.to_string_lossy().to_string()))
}

async fn handle_attachments(
    connection_id: &str,
    session_key: &str,
    reply_ctx: &str,
    val: &Value,
    app: &tauri::AppHandle,
    history: &ChatHistory,
) {
    let attachments = val
        .get("attachments")
        .or_else(|| val.get("data").and_then(|d| d.get("attachments")))
        .and_then(|v| v.as_array());

    if let Some(atts) = attachments {
        for att in atts {
            if let Some((name, path)) = save_attachment(att) {
                // Save file message to history
                let msg = ChatMessage {
                    id: format!("bot-file-{}", chrono::Utc::now().timestamp_millis()),
                    connection_id: connection_id.to_string(),
                    session_key: session_key.to_string(),
                    role: "bot".to_string(),
                    content: name.clone(),
                    content_type: "file".to_string(),
                    file_path: Some(path.clone()),
                    timestamp: chrono::Utc::now().timestamp_millis() as f64,
                };
                if let Err(e) = history.add(&msg).await {
                    eprintln!("[bridge] failed to save file to history: {e}");
                }
                let _ = app.emit(
                    "bridge-file-received",
                    json!({
                        "connectionId": connection_id,
                        "sessionKey": session_key,
                        "replyCtx": reply_ctx,
                        "name": name,
                        "path": path
                    }),
                );
            }
        }
    }
}

fn default_session_key(cfg: &BridgeConfig) -> String {
    format!("{}:{}:{}", cfg.platform_name, cfg.user_id, cfg.user_id)
}

fn default_reply_ctx(cfg: &BridgeConfig) -> String {
    format!("ctx-{}", cfg.user_id)
}

fn make_message(
    text: &str,
    cfg: &BridgeConfig,
    session_key: Option<&str>,
    reply_ctx: Option<&str>,
) -> String {
    let session_key = session_key
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| default_session_key(cfg));
    let reply_ctx = reply_ctx
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| default_reply_ctx(cfg));
    json!({
        "type": "message",
        "msg_id": format!("pet-{}", uuid::Uuid::new_v4().to_string()[..8].to_string()),
        "session_key": session_key,
        "user_id": cfg.user_id,
        "user_name": "Desktop Pet",
        "content": text,
        "reply_ctx": reply_ctx,
    })
    .to_string()
}

fn make_file_message(
    path: &str,
    cfg: &BridgeConfig,
    session_key: Option<&str>,
    reply_ctx: Option<&str>,
) -> Result<String, String> {
    let file_path = std::path::Path::new(path);
    let data = std::fs::read(file_path).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    let name = file_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let session_key = session_key
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| default_session_key(cfg));
    let reply_ctx = reply_ctx
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| default_reply_ctx(cfg));
    Ok(json!({
        "type": "message",
        "msg_id": format!("pet-file-{}", uuid::Uuid::new_v4().to_string()[..8].to_string()),
        "session_key": session_key,
        "user_id": cfg.user_id,
        "user_name": "Desktop Pet",
        "content": format!("[文件: {}]", name),
        "reply_ctx": reply_ctx,
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
    connection_id: String,
    cfg: BridgeConfig,
    app: tauri::AppHandle,
    rx: Arc<Mutex<mpsc::Receiver<BridgeCommand>>>,
    client_id: u64,
    connected: Arc<AtomicBool>,
    history: ChatHistory,
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
                    let _ = app.emit(
                        "bridge-error",
                        json!({ "connectionId": connection_id, "error": format!("Register failed: {e}") }),
                    );
                    continue;
                }
                eprintln!("[bridge:{client_id}] register sent");

                let app2 = app.clone();
                let cfg2 = cfg.clone();
                let rx2 = rx.clone();
                let connection_id2 = connection_id.clone();

                // send loop
                let send_handle = tokio::spawn(async move {
                    let mut rx = rx2.lock().await;
                    loop {
                        tokio::select! {
                            cmd = rx.recv() => {
                                match cmd {
                                    Some(BridgeCommand::SendText { text, session_key, reply_ctx }) => {
                                        let msg = make_message(
                                            &text,
                                            &cfg2,
                                            session_key.as_deref(),
                                            reply_ctx.as_deref(),
                                        );
                                        eprintln!("[bridge:{client_id}] sending text frame, bytes={}", msg.len());
                                        if write.send(Message::Text(msg.into())).await.is_err() {
                                            eprintln!("[bridge:{client_id}] send text failed; disconnected");
                                            return SendLoopExit::Disconnected;
                                        }
                                        eprintln!("[bridge:{client_id}] text frame sent");
                                    }
                                    Some(BridgeCommand::SendFile { path, session_key, reply_ctx }) => {
                                        match make_file_message(
                                            &path,
                                            &cfg2,
                                            session_key.as_deref(),
                                            reply_ctx.as_deref(),
                                        ) {
                                            Ok(msg) => {
                                                if write.send(Message::Text(msg.into())).await.is_err() {
                                                    eprintln!("[bridge:{client_id}] send file failed; disconnected");
                                                    return SendLoopExit::Disconnected;
                                                }
                                            }
                                            Err(e) => {
                                                let _ = app2.emit(
                                                    "bridge-error",
                                                    json!({ "connectionId": connection_id2, "error": format!("File send failed: {e}") }),
                                                );
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
                let connection_id3 = connection_id.clone();
                let history3 = history.clone();
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
                                handle_message(&connection_id3, &val, &app3, &history3).await;
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
                let _ = app.emit(
                    "bridge-connected",
                    json!({ "connectionId": connection_id, "connected": false }),
                );
                if !should_reconnect {
                    eprintln!("[bridge:{client_id}] stopped by request; exiting loop");
                    return;
                }
            }
            Err(e) => {
                eprintln!("[bridge:{client_id}] connect failed: {e}");
                connected.store(false, Ordering::Relaxed);
                let _ = app.emit(
                    "bridge-error",
                    json!({ "connectionId": connection_id, "error": format!("Connection failed: {e}") }),
                );
                let _ = app.emit(
                    "bridge-connected",
                    json!({ "connectionId": connection_id, "connected": false }),
                );
            }
        }

        eprintln!("[bridge:{client_id}] reconnect in {}s", backoff.min(60));
        tokio::time::sleep(tokio::time::Duration::from_secs(backoff.min(60))).await;
        backoff = (backoff * 2).min(60);
    }
}

async fn handle_message(connection_id: &str, val: &Value, app: &tauri::AppHandle, history: &ChatHistory) {
    let session_key = val
        .get("session_key")
        .and_then(|v| v.as_str())
        .or_else(|| val.get("data").and_then(|d| d.get("session_key")).and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    let reply_ctx = val
        .get("reply_ctx")
        .and_then(|v| v.as_str())
        .or_else(|| val.get("data").and_then(|d| d.get("reply_ctx")).and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    let msg_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match msg_type {
        "register_ack" => {
            if val.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                eprintln!("[bridge] register_ack ok");
                let _ = app.emit(
                    "bridge-connected",
                    json!({ "connectionId": connection_id, "connected": true }),
                );
            } else {
                let err = val
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                eprintln!("[bridge] register_ack rejected: {err}");
                let _ = app.emit(
                    "bridge-error",
                    json!({ "connectionId": connection_id, "error": format!("Registration rejected: {err}") }),
                );
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
                    // Save to history
                    let msg = ChatMessage {
                        id: format!("bot-{}", chrono::Utc::now().timestamp_millis()),
                        connection_id: connection_id.to_string(),
                        session_key: session_key.clone(),
                        role: "bot".to_string(),
                        content: content.to_string(),
                        content_type: "text".to_string(),
                        file_path: None,
                        timestamp: chrono::Utc::now().timestamp_millis() as f64,
                    };
                    if let Err(e) = history.add(&msg).await {
                        eprintln!("[bridge] failed to save reply to history: {e}");
                    }
                    let _ = app.emit(
                        "bridge-message",
                        json!({
                            "connectionId": connection_id,
                            "sessionKey": session_key,
                            "replyCtx": reply_ctx,
                            "content": content
                        }),
                    );
                }
            }
            handle_attachments(connection_id, &session_key, &reply_ctx, val, app, history).await;
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
                    // Save to history
                    let msg = ChatMessage {
                        id: format!("bot-{}", chrono::Utc::now().timestamp_millis()),
                        connection_id: connection_id.to_string(),
                        session_key: session_key.clone(),
                        role: "bot".to_string(),
                        content: text.clone(),
                        content_type: "text".to_string(),
                        file_path: None,
                        timestamp: chrono::Utc::now().timestamp_millis() as f64,
                    };
                    if let Err(e) = history.add(&msg).await {
                        eprintln!("[bridge] failed to save stream-done to history: {e}");
                    }
                    let _ = app.emit(
                        "bridge-stream-done",
                        json!({
                            "connectionId": connection_id,
                            "sessionKey": session_key,
                            "replyCtx": reply_ctx,
                            "fullText": text
                        }),
                    );
                } else {
                    eprintln!("[bridge] emit bridge-stream-done empty");
                    let _ = app.emit(
                        "bridge-stream-done",
                        json!({
                            "connectionId": connection_id,
                            "sessionKey": session_key,
                            "replyCtx": reply_ctx,
                            "fullText": String::new()
                        }),
                    );
                }
                handle_attachments(connection_id, &session_key, &reply_ctx, val, app, history).await;
            } else if let Some(chunk) = reply_stream_chunk(val) {
                if !chunk.is_empty() {
                    eprintln!("[bridge] emit bridge-stream-delta len={}", chunk.len());
                    let _ = app.emit(
                        "bridge-stream-delta",
                        json!({
                            "connectionId": connection_id,
                            "sessionKey": session_key,
                            "replyCtx": reply_ctx,
                            "delta": chunk
                        }),
                    );
                }
            }
        }
        "buttons" => {
            if let Some(content) = val.get("content").and_then(|v| v.as_str()) {
                if !content.is_empty() {
                    eprintln!("[bridge] emit bridge-message(buttons) len={}", content.len());
                    // Save to history
                    let msg = ChatMessage {
                        id: format!("bot-{}", chrono::Utc::now().timestamp_millis()),
                        connection_id: connection_id.to_string(),
                        session_key: session_key.clone(),
                        role: "bot".to_string(),
                        content: content.to_string(),
                        content_type: "text".to_string(),
                        file_path: None,
                        timestamp: chrono::Utc::now().timestamp_millis() as f64,
                    };
                    if let Err(e) = history.add(&msg).await {
                        eprintln!("[bridge] failed to save buttons to history: {e}");
                    }
                    let _ = app.emit(
                        "bridge-message",
                        json!({
                            "connectionId": connection_id,
                            "sessionKey": session_key,
                            "replyCtx": reply_ctx,
                            "content": content
                        }),
                    );
                }
            }
        }
        "error" => {
            let msg = val
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Bridge error");
            let _ = app.emit(
                "bridge-error",
                json!({ "connectionId": connection_id, "error": msg }),
            );
        }
        "" => {
            // No explicit type field - treat as a plain message if content is present
            if let Some(content) = val
                .get("content")
                .and_then(|v| v.as_str())
                .or_else(|| val.get("text").and_then(|v| v.as_str()))
            {
                if !content.is_empty() {
                    eprintln!("[bridge] emit bridge-message (no type) len={}", content.len());
                    // Save to history
                    let msg = ChatMessage {
                        id: format!("bot-{}", chrono::Utc::now().timestamp_millis()),
                        connection_id: connection_id.to_string(),
                        session_key: session_key.clone(),
                        role: "bot".to_string(),
                        content: content.to_string(),
                        content_type: "text".to_string(),
                        file_path: None,
                        timestamp: chrono::Utc::now().timestamp_millis() as f64,
                    };
                    if let Err(e) = history.add(&msg).await {
                        eprintln!("[bridge] failed to save no-type message to history: {e}");
                    }
                    let _ = app.emit(
                        "bridge-message",
                        json!({
                            "connectionId": connection_id,
                            "sessionKey": session_key,
                            "replyCtx": reply_ctx,
                            "content": content
                        }),
                    );
                }
            } else {
                eprintln!("[bridge] ignored message with no type and no content");
            }
        }
        other => {
            eprintln!("[bridge] ignored message type={}", other);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn test_cfg() -> BridgeConfig {
        BridgeConfig {
            id: "test-bridge".to_string(),
            name: "Test".to_string(),
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
    fn normalize_host_leaves_standard_ipv4_unchanged() {
        assert_eq!(normalize_host("127.0.0.1"), "127.0.0.1");
        assert_eq!(normalize_host("192.168.0.1"), "192.168.0.1");
        assert_eq!(normalize_host("8.8.8.8"), "8.8.8.8");
    }

    #[test]
    fn normalize_host_keeps_invalid_or_unusual_segments_as_is() {
        assert_eq!(normalize_host("127..1"), "127..1");
        assert_eq!(normalize_host("a.b.c"), "a.b.c");
        assert_eq!(normalize_host("1.2.3.4.5"), "1.2.3.4.5");
        assert_eq!(normalize_host("256.0.1"), "256.0.1");
        assert_eq!(normalize_host("1.2.999"), "1.2.999");
    }

    #[test]
    fn normalize_host_trims_whitespace_for_three_segment_rule() {
        assert_eq!(normalize_host("  127.0.01  "), "127.0.0.1");
    }

    #[test]
    fn register_payload_has_required_fields() {
        let v: Value = serde_json::from_str(&make_register("desktop-pet")).unwrap();
        assert_eq!(v["type"], "register");
        assert_eq!(v["platform"], "desktop-pet");
    }

    #[test]
    fn register_payload_has_capabilities_and_metadata() {
        let v: Value = serde_json::from_str(&make_register("my-platform")).unwrap();
        let caps: HashSet<&str> = v["capabilities"]
            .as_array()
            .expect("capabilities array")
            .iter()
            .filter_map(|x| x.as_str())
            .collect();
        for need in ["text", "buttons", "file"] {
            assert!(caps.contains(need), "missing capability {need:?}");
        }
        let meta = v["metadata"].as_object().expect("metadata object");
        assert_eq!(meta.get("protocol_version").and_then(|x| x.as_u64()), Some(1));
        let version = meta
            .get("version")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        assert!(!version.is_empty(), "metadata.version should be non-empty");
        let description = meta
            .get("description")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        assert!(
            !description.is_empty(),
            "metadata.description should be non-empty"
        );
    }

    #[test]
    fn message_payload_has_session_key() {
        let v: Value = serde_json::from_str(&make_message("hello", &test_cfg(), None, None)).unwrap();
        assert_eq!(v["type"], "message");
        assert_eq!(v["content"], "hello");
        assert_eq!(v["session_key"], "desktop-pet:pet-user:pet-user");
    }

    #[test]
    fn make_message_json_includes_type_content_and_session_key() {
        let cfg = test_cfg();
        let raw = make_message("ping 测试", &cfg, None, None);
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v.get("type").and_then(|x| x.as_str()), Some("message"));
        assert_eq!(v.get("content").and_then(|x| x.as_str()), Some("ping 测试"));
        assert_eq!(
            v.get("session_key").and_then(|x| x.as_str()),
            Some("desktop-pet:pet-user:pet-user")
        );
    }

    #[test]
    fn reply_stream_chunk_extracts_delta_string() {
        let v: Value = serde_json::from_str(r#"{"delta":"a"}"#).unwrap();
        assert_eq!(reply_stream_chunk(&v), Some("a".to_string()));
    }

    #[test]
    fn reply_stream_chunk_extracts_delta_content() {
        let v: Value = serde_json::from_str(r#"{"delta":{"content":"b"}}"#).unwrap();
        assert_eq!(reply_stream_chunk(&v), Some("b".to_string()));
    }

    #[test]
    fn reply_stream_chunk_extracts_chunk() {
        let v: Value = serde_json::from_str(r#"{"chunk":"c"}"#).unwrap();
        assert_eq!(reply_stream_chunk(&v), Some("c".to_string()));
    }

    #[test]
    fn reply_stream_chunk_extracts_data_variants() {
        let a: Value = serde_json::from_str(r#"{"data":{"delta":"x"}}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"data":{"content":"y"}}"#).unwrap();
        let c: Value = serde_json::from_str(r#"{"data":{"text":"z"}}"#).unwrap();
        let d: Value = serde_json::from_str(r#"{"data":{"delta":{"content":"k"}}}"#).unwrap();
        assert_eq!(reply_stream_chunk(&a), Some("x".to_string()));
        assert_eq!(reply_stream_chunk(&b), Some("y".to_string()));
        assert_eq!(reply_stream_chunk(&c), Some("z".to_string()));
        assert_eq!(reply_stream_chunk(&d), Some("k".to_string()));
    }

    #[test]
    fn reply_stream_chunk_falls_back_to_top_level_text_and_content() {
        let a: Value = serde_json::from_str(r#"{"text":"t"}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"content":"u"}"#).unwrap();
        assert_eq!(reply_stream_chunk(&a), Some("t".to_string()));
        assert_eq!(reply_stream_chunk(&b), Some("u".to_string()));
    }

    #[test]
    fn reply_stream_chunk_returns_none_when_no_text_like_field() {
        let done: Value = serde_json::from_str(r#"{"done":true}"#).unwrap();
        let empty: Value = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(reply_stream_chunk(&done), None);
        assert_eq!(reply_stream_chunk(&empty), None);
    }

    #[test]
    fn make_message_uses_custom_session_fields_when_provided() {
        let cfg = test_cfg();
        let raw = make_message(
            "hello",
            &cfg,
            Some("desktop-pet:user-a:room-42"),
            Some("ctx-room-42"),
        );
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            v.get("session_key").and_then(|x| x.as_str()),
            Some("desktop-pet:user-a:room-42")
        );
        assert_eq!(v.get("reply_ctx").and_then(|x| x.as_str()), Some("ctx-room-42"));
    }
}
