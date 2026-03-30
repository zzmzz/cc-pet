mod bridge;
mod config;
pub mod history;
mod link_preview;
mod llm;
mod tunnel;
mod update;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, LogicalSize, Manager, Size};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use bridge::BridgeClient;
use config::{AppConfig, LlmConfig, PetAppearanceConfig};
use history::{ChatHistory, ChatMessage};
use llm::LlmMessage;

struct AppState {
    bridges: Mutex<HashMap<String, BridgeClient>>,
    tunnels: Mutex<HashMap<String, tunnel::SshTunnelProcess>>,
    bridge_connect_lock: Mutex<()>,
    history: ChatHistory,
    config: Mutex<AppConfig>,
    tray: StdMutex<Option<tauri::tray::TrayIcon>>,
    visibility_shortcut: StdMutex<Option<String>>,
    shutdown_started: StdMutex<bool>,
}

const DEFAULT_TOGGLE_SHORTCUT: &str = "Ctrl+Shift+H";

fn default_session_key(bridge: &config::BridgeConfig) -> String {
    format!(
        "{}:{}:{}",
        bridge.platform_name, bridge.user_id, bridge.user_id
    )
}

fn history_content_for_sent_files(caption: &Option<String>, paths: &[String]) -> String {
    let file_lines: Vec<String> = paths
        .iter()
        .filter_map(|p| {
            Path::new(p)
                .file_name()
                .map(|n| format!("📎 {}", n.to_string_lossy()))
        })
        .collect();
    match (
        caption.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()),
        file_lines.len(),
    ) {
        (Some(c), 0) => c.to_string(),
        (Some(c), _) => format!("{c}\n\n{}", file_lines.join("\n")),
        (None, 0) => String::new(),
        (None, 1) => file_lines.into_iter().next().unwrap_or_default(),
        (None, _) => file_lines.join("\n"),
    }
}

async fn resolve_session_key(
    state: &tauri::State<'_, Arc<AppState>>,
    connection_id: &str,
    requested: Option<String>,
) -> Option<String> {
    if let Some(s) = requested {
        if !s.trim().is_empty() {
            return Some(s);
        }
    }
    let cfg = state.config.lock().await.clone();
    cfg.bridges
        .iter()
        .find(|b| b.id == connection_id)
        .map(default_session_key)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeStatus {
    id: String,
    name: String,
    connected: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshTunnelStatus {
    id: String,
    running: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeSessionItem {
    id: String,
    name: String,
    #[serde(rename = "history_count")]
    history_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeSessionsData {
    sessions: Vec<BridgeSessionItem>,
    #[serde(rename = "active_session_id")]
    active_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalSessionsData {
    sessions: Vec<BridgeSessionItem>,
    active_session_id: Option<String>,
    last_active_map: HashMap<String, f64>,
}

#[derive(Debug, Deserialize)]
struct BridgeEnvelope<T> {
    ok: bool,
    data: Option<T>,
    error: Option<String>,
}

async fn switch_remote_session_if_needed(
    state: &tauri::State<'_, Arc<AppState>>,
    connection_id: &str,
    target: &str,
) -> Result<(), String> {
    if target.trim().is_empty() || target.contains(':') {
        return Ok(());
    }
    let cfg = state.config.lock().await.clone();
    let bridge_cfg = cfg
        .bridges
        .iter()
        .find(|b| b.id == connection_id)
        .cloned()
        .ok_or_else(|| format!("Bridge not found: {connection_id}"))?;
    let session_key = default_session_key(&bridge_cfg);
    let url = format!("http://{}:{}/bridge/sessions/switch", bridge_cfg.host, bridge_cfg.port);
    let client = reqwest::Client::new();
    let resp = client
        .post(url)
        .bearer_auth(bridge_cfg.token)
        .json(&serde_json::json!({
            "session_key": session_key,
            "target": target,
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body: BridgeEnvelope<serde_json::Value> = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() || !body.ok {
        let err = body.error.unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
        return Err(format!("Switch session failed: {err}"));
    }
    Ok(())
}

#[tauri::command]
async fn list_bridge_sessions(
    connection_id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<BridgeSessionsData, String> {
    let cfg = state.config.lock().await.clone();
    let bridge_cfg = cfg
        .bridges
        .iter()
        .find(|b| b.id == connection_id)
        .cloned()
        .ok_or_else(|| format!("Bridge not found: {connection_id}"))?;
    let session_key = default_session_key(&bridge_cfg);
    let url = format!(
        "http://{}:{}/bridge/sessions?session_key={}",
        bridge_cfg.host,
        bridge_cfg.port,
        urlencoding::encode(&session_key)
    );
    let client = reqwest::Client::new();
    let resp = client
        .get(url)
        .bearer_auth(bridge_cfg.token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body: BridgeEnvelope<BridgeSessionsData> = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() || !body.ok {
        let err = body.error.unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
        return Err(format!("List sessions failed: {err}"));
    }
    let data = body.data.unwrap_or(BridgeSessionsData {
        sessions: vec![],
        active_session_id: None,
    });

    eprintln!(
        "[sessions] list_bridge_sessions conn={} got {} sessions, active={:?}, ids={:?}",
        connection_id,
        data.sessions.len(),
        data.active_session_id,
        data.sessions.iter().map(|s| &s.id).collect::<Vec<_>>()
    );

    // Persist to local DB so sessions survive restarts
    let pairs: Vec<(String, String)> = data
        .sessions
        .iter()
        .map(|s| (s.id.clone(), s.name.clone()))
        .collect();
    match state
        .history
        .save_sessions(
            &connection_id,
            &pairs,
            data.active_session_id.as_deref(),
        )
        .await
    {
        Ok(()) => eprintln!(
            "[sessions] save_sessions OK conn={} saved {} sessions",
            connection_id,
            pairs.len()
        ),
        Err(e) => eprintln!(
            "[sessions] save_sessions FAILED conn={} err={}",
            connection_id, e
        ),
    }

    // Return locally-preserved names instead of raw Bridge names
    let mut data = data;
    if let Ok(saved) = state.history.load_sessions(&connection_id).await {
        let name_map: HashMap<String, String> = saved.into_iter().map(|s| (s.id, s.name)).collect();
        for s in &mut data.sessions {
            if let Some(n) = name_map.get(&s.id) {
                if !n.is_empty() {
                    s.name = n.clone();
                }
            }
        }
    }

    Ok(data)
}

#[tauri::command]
async fn list_local_sessions(
    connection_id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<LocalSessionsData, String> {
    let rows = state.history.load_sessions(&connection_id).await?;
    let active = rows.iter().find(|r| r.active).map(|r| r.id.clone());
    let mut last_active_map = HashMap::new();
    let sessions: Vec<BridgeSessionItem> = rows
        .into_iter()
        .map(|r| {
            if let Some(ts) = r.last_active_at {
                last_active_map.insert(r.id.clone(), ts);
            }
            BridgeSessionItem {
                id: r.id,
                name: r.name,
                history_count: 0,
            }
        })
        .collect();
    eprintln!(
        "[sessions] list_local_sessions conn={} found {} cached sessions, active={:?}, ids={:?}",
        connection_id,
        sessions.len(),
        active,
        sessions.iter().map(|s| &s.id).collect::<Vec<_>>()
    );
    Ok(LocalSessionsData {
        sessions,
        active_session_id: active,
        last_active_map,
    })
}

#[tauri::command]
async fn update_session_label(
    connection_id: String,
    session_id: String,
    label: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    state
        .history
        .update_session_label(&connection_id, &session_id, &label)
        .await
}

#[tauri::command]
async fn create_bridge_session(
    connection_id: String,
    name: Option<String>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let cfg = state.config.lock().await.clone();
    let bridge_cfg = cfg
        .bridges
        .iter()
        .find(|b| b.id == connection_id)
        .cloned()
        .ok_or_else(|| format!("Bridge not found: {connection_id}"))?;
    let session_key = default_session_key(&bridge_cfg);
    let url = format!("http://{}:{}/bridge/sessions", bridge_cfg.host, bridge_cfg.port);
    let client = reqwest::Client::new();
    let resp = client
        .post(url)
        .bearer_auth(bridge_cfg.token)
        .json(&serde_json::json!({
            "session_key": session_key,
            "name": name.unwrap_or_else(|| "default".to_string()),
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body: BridgeEnvelope<serde_json::Value> = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() || !body.ok {
        let err = body.error.unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
        return Err(format!("Create session failed: {err}"));
    }
    Ok(())
}

#[tauri::command]
async fn switch_bridge_session(
    connection_id: String,
    target: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    switch_remote_session_if_needed(&state, &connection_id, &target).await
}

#[tauri::command]
async fn delete_bridge_session(
    connection_id: String,
    session_id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let cfg = state.config.lock().await.clone();
    let bridge_cfg = cfg
        .bridges
        .iter()
        .find(|b| b.id == connection_id)
        .cloned()
        .ok_or_else(|| format!("Bridge not found: {connection_id}"))?;
    let session_key = default_session_key(&bridge_cfg);
    let url = format!(
        "http://{}:{}/bridge/sessions/{}?session_key={}",
        bridge_cfg.host,
        bridge_cfg.port,
        urlencoding::encode(&session_id),
        urlencoding::encode(&session_key)
    );
    let client = reqwest::Client::new();
    let resp = client
        .delete(url)
        .bearer_auth(bridge_cfg.token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body: BridgeEnvelope<serde_json::Value> = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() || !body.ok {
        let err = body.error.unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
        return Err(format!("Delete session failed: {err}"));
    }
    Ok(())
}

#[tauri::command]
async fn load_config() -> Result<AppConfig, String> {
    config::load_config()
}

#[tauri::command]
async fn save_config(
    mut config: AppConfig,
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let shortcut = apply_toggle_shortcut(&app, state.inner(), &config.pet.toggle_visibility_shortcut)?;
    config.pet.toggle_visibility_shortcut = shortcut;
    apply_launch_on_startup(&app, config.pet.launch_on_startup)?;
    config::save_config(&config)?;
    *state.config.lock().await = config;
    Ok(())
}

fn apply_launch_on_startup(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let autolaunch = app.autolaunch();
    if enabled {
        autolaunch
            .enable()
            .map_err(|e| format!("enable autostart failed: {e}"))?;
    } else {
        autolaunch
            .disable()
            .map_err(|e| format!("disable autostart failed: {e}"))?;
    }
    Ok(())
}

fn validate_ssh_tunnel(cfg: &config::SshTunnelConfig) -> Result<(), String> {
    if cfg.bastion_host.trim().is_empty() {
        return Err("SSH bastion host is required".into());
    }
    if cfg.bastion_user.trim().is_empty() {
        return Err("SSH bastion user is required".into());
    }
    if cfg.target_host.trim().is_empty() {
        return Err("SSH target host is required".into());
    }
    if cfg.local_host.trim().is_empty() {
        return Err("SSH local host is required".into());
    }
    Ok(())
}

#[tauri::command]
async fn start_ssh_tunnel(
    connection_id: String,
    tunnel_config: Option<config::SshTunnelConfig>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let tunnel_cfg = if let Some(cfg) = tunnel_config {
        cfg
    } else {
        let cfg = state.config.lock().await.clone();
        let bridge_cfg = cfg
            .bridges
            .iter()
            .find(|b| b.id == connection_id)
            .cloned()
            .ok_or_else(|| format!("Bridge not found: {connection_id}"))?;
        bridge_cfg
            .ssh_tunnel
            .ok_or_else(|| "SSH tunnel config not found".to_string())?
    };
    if !tunnel_cfg.enabled {
        return Err("SSH tunnel is disabled in config".into());
    }
    validate_ssh_tunnel(&tunnel_cfg)?;

    let mut guard = state.tunnels.lock().await;
    if let Some(existing) = guard.get_mut(&connection_id) {
        if let Ok(None) = existing.child.try_wait() {
            return Ok(());
        }
    }

    let mut proc = tunnel::spawn_ssh_tunnel(&tunnel_cfg)?;
    std::thread::sleep(std::time::Duration::from_millis(300));
    if let Ok(Some(status)) = proc.child.try_wait() {
        let stderr = tunnel::read_process_stderr(&mut proc.child);
        if stderr.is_empty() {
            return Err(format!("ssh exited early: {status}"));
        }
        return Err(format!("ssh exited early: {status}; {stderr}"));
    }
    guard.insert(connection_id, proc);
    Ok(())
}

#[tauri::command]
async fn stop_ssh_tunnel(
    connection_id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let mut guard = state.tunnels.lock().await;
    if let Some(mut proc) = guard.remove(&connection_id) {
        let _ = proc.child.kill();
        let _ = proc.child.wait();
    }
    Ok(())
}

#[tauri::command]
async fn get_ssh_tunnel_status(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<SshTunnelStatus>, String> {
    let cfg = state.config.lock().await.clone();
    let mut guard = state.tunnels.lock().await;
    let mut statuses = Vec::new();

    for bridge in cfg.bridges {
        let running = if let Some(proc) = guard.get_mut(&bridge.id) {
            matches!(proc.child.try_wait(), Ok(None))
        } else {
            false
        };
        statuses.push(SshTunnelStatus {
            id: bridge.id,
            running,
        });
    }
    Ok(statuses)
}

fn mark_shutdown_started(state: &Arc<AppState>) -> bool {
    match state.shutdown_started.lock() {
        Ok(mut started) => {
            if *started {
                false
            } else {
                *started = true;
                true
            }
        }
        Err(_) => false,
    }
}

async fn shutdown_network_resources(state: &Arc<AppState>) {
    if !mark_shutdown_started(state) {
        return;
    }

    let clients: Vec<BridgeClient> = {
        let mut guard = state.bridges.lock().await;
        guard.drain().map(|(_, client)| client).collect()
    };
    for client in clients {
        client.stop().await;
    }

    let mut tunnels = state.tunnels.lock().await;
    for (_, mut proc) in tunnels.drain() {
        let _ = proc.child.kill();
        let _ = proc.child.wait();
    }
}

#[tauri::command]
async fn connect_bridge(
    connection_id: String,
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let _connect_guard = state.bridge_connect_lock.lock().await;
    let cfg = state.config.lock().await.clone();
    let bridge_cfg = cfg
        .bridges
        .iter()
        .find(|b| b.id == connection_id)
        .cloned()
        .ok_or_else(|| format!("Bridge not found: {connection_id}"))?;
    if bridge_cfg.token.trim().is_empty() {
        return Err("Token is empty — configure Bridge first".into());
    }

    let existing = {
        let mut guard = state.bridges.lock().await;
        guard.remove(&connection_id)
    };
    if let Some(prev) = existing {
        eprintln!("[bridge] reconnect: stop previous client id={connection_id}");
        prev.stop().await;
    }

    eprintln!(
        "[bridge] starting client id={} host={} port={} platform={}",
        connection_id, bridge_cfg.host, bridge_cfg.port, bridge_cfg.platform_name
    );
    let history = state.history.clone();
    let client = BridgeClient::start(connection_id.clone(), bridge_cfg, app, history);
    state.bridges.lock().await.insert(connection_id, client);
    Ok(())
}

#[tauri::command]
async fn disconnect_bridge(
    connection_id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let _connect_guard = state.bridge_connect_lock.lock().await;
    let client = state.bridges.lock().await.remove(&connection_id);
    if let Some(client) = client {
        eprintln!("[bridge] disconnect requested");
        client.stop().await;
    }
    Ok(())
}

#[tauri::command]
async fn get_bridge_status(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<BridgeStatus>, String> {
    let cfg = state.config.lock().await.clone();
    let guard = state.bridges.lock().await;
    let statuses = cfg
        .bridges
        .into_iter()
        .map(|b| BridgeStatus {
            id: b.id.clone(),
            name: b.name.clone(),
            connected: guard.get(&b.id).map(|c| c.is_connected()).unwrap_or(false),
        })
        .collect();
    Ok(statuses)
}

#[tauri::command]
async fn send_message(
    connection_id: String,
    text: String,
    session_key: Option<String>,
    reply_ctx: Option<String>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    eprintln!("[bridge] send_message called, len={}", text.len());
    let guard = state.bridges.lock().await;
    let client = match guard.get(&connection_id) {
        Some(c) => c,
        None => {
            eprintln!("[bridge] send_message rejected: no active bridge client");
            return Err("Not connected".into());
        }
    };
    // save to history
    if let Some(target) = session_key.as_deref() {
        switch_remote_session_if_needed(&state, &connection_id, target).await?;
    }
    let msg = ChatMessage {
        id: format!("user-{}", chrono::Utc::now().timestamp_millis()),
        connection_id: connection_id.clone(),
        session_key: resolve_session_key(&state, &connection_id, session_key.clone())
            .await
            .unwrap_or_default(),
        role: "user".into(),
        content: text.clone(),
        content_type: "text".into(),
        file_path: None,
        timestamp: chrono::Utc::now().timestamp_millis() as f64,
    };
    if let Err(e) = state.history.add(&msg).await {
        eprintln!("[bridge] history add failed, continue sending: {e}");
    }
    let ws_session_key = resolve_session_key(&state, &connection_id, session_key).await;
    let result = client
        .send_text(text, ws_session_key, reply_ctx)
        .await;
    if let Err(ref e) = result {
        eprintln!("[bridge] send_message enqueue failed: {e}");
    } else {
        eprintln!("[bridge] send_message enqueued");
    }
    result
}

#[tauri::command]
async fn send_files(
    connection_id: String,
    paths: Vec<String>,
    text: Option<String>,
    session_key: Option<String>,
    reply_ctx: Option<String>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if paths.is_empty() {
        return Err("未选择文件".into());
    }
    if let Some(target) = session_key.as_deref() {
        switch_remote_session_if_needed(&state, &connection_id, target).await?;
    }
    let guard = state.bridges.lock().await;
    let client = match guard.get(&connection_id) {
        Some(c) => c,
        None => {
            eprintln!("[bridge] send_files rejected: no active bridge client");
            return Err("Not connected".into());
        }
    };
    let caption = text.filter(|s| !s.trim().is_empty());
    let hist_content = history_content_for_sent_files(&caption, &paths);
    let msg = ChatMessage {
        id: format!("file-{}", chrono::Utc::now().timestamp_millis()),
        connection_id: connection_id.clone(),
        session_key: resolve_session_key(&state, &connection_id, session_key.clone())
            .await
            .unwrap_or_default(),
        role: "user".into(),
        content: hist_content,
        content_type: "file".into(),
        file_path: Some(paths[0].clone()),
        timestamp: chrono::Utc::now().timestamp_millis() as f64,
    };
    if let Err(e) = state.history.add(&msg).await {
        eprintln!("[bridge] history add failed for file, continue sending: {e}");
    }
    let ws_session_key = resolve_session_key(&state, &connection_id, session_key).await;
    client
        .send_files(paths, caption, ws_session_key, reply_ctx)
        .await
}

#[tauri::command]
async fn send_file(
    connection_id: String,
    path: String,
    session_key: Option<String>,
    reply_ctx: Option<String>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    send_files(
        connection_id,
        vec![path],
        None,
        session_key,
        reply_ctx,
        state,
    )
    .await
}

#[tauri::command]
async fn send_card_action(
    connection_id: String,
    action: String,
    session_key: Option<String>,
    reply_ctx: Option<String>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if let Some(target) = session_key.as_deref() {
        switch_remote_session_if_needed(&state, &connection_id, target).await?;
    }
    let guard = state.bridges.lock().await;
    let client = match guard.get(&connection_id) {
        Some(c) => c,
        None => return Err("Not connected".into()),
    };
    let ws_session_key = resolve_session_key(&state, &connection_id, session_key).await;
    client.send_card_action(action, ws_session_key, reply_ctx).await
}

#[tauri::command]
async fn get_history(
    connection_id: String,
    session_key: Option<String>,
    limit: u32,
    before_id: Option<String>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<ChatMessage>, String> {
    state
        .history
        .recent(&connection_id, session_key.as_deref(), limit, before_id.as_deref()).await
}

#[tauri::command]
async fn clear_history(
    connection_id: Option<String>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    state.history.clear(connection_id.as_deref()).await
}

#[tauri::command]
async fn set_always_on_top(on: bool, app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.set_always_on_top(on).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn llm_chat(
    messages: Vec<LlmMessage>,
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let cfg = state.config.lock().await.clone();
    if !cfg.llm.enabled || cfg.llm.api_url.is_empty() {
        return Err("LLM not configured".into());
    }
    llm::chat_stream(&cfg.llm, messages, &app).await
}

#[tauri::command]
async fn llm_generate_image(
    prompt: String,
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let cfg = state.config.lock().await.clone();
    if !cfg.llm.enabled || cfg.llm.api_url.is_empty() {
        return Err("LLM not configured".into());
    }
    llm::generate_image(&cfg.llm, &prompt, &app).await
}

#[tauri::command]
async fn set_window_opacity(opacity: f64, app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.set_effects(tauri::window::EffectsBuilder::new().build())
            .ok();
        // Tauri v2 doesn't have direct opacity API, but we can use alpha
        // The frontend handles opacity via CSS
    }
    let _ = app.emit("opacity-changed", opacity);
    Ok(())
}

#[tauri::command]
async fn reveal_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("File not found".into());
    }

    #[cfg(target_os = "windows")]
    {
        let parent = p.parent().ok_or_else(|| "Invalid file path".to_string())?;
        std::process::Command::new("explorer")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(parent) = p.parent() {
            std::process::Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

#[tauri::command]
async fn quit_app(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Arc<AppState>>();
    shutdown_network_resources(state.inner()).await;
    app.exit(0);
    Ok(())
}

#[tauri::command]
async fn toggle_window_visibility(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    toggle_main_window_visibility(&app, &state)
}

#[tauri::command]
async fn check_for_updates() -> Result<update::UpdateCheckResult, String> {
    update::check_github_update(env!("CARGO_PKG_VERSION")).await
}

#[tauri::command]
async fn fetch_link_preview(url: String) -> Result<link_preview::LinkPreviewData, String> {
    link_preview::fetch(&url).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileDownloadProgressEvent {
    id: String,
    url: String,
    status: String,
    file_name: String,
    path: Option<String>,
    received_bytes: u64,
    total_bytes: Option<u64>,
    error: Option<String>,
}

fn sanitize_file_name(name: &str) -> String {
    let mut cleaned = name
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ if ch.is_control() => '_',
            _ => ch,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    if cleaned.is_empty() {
        cleaned = "download".to_string();
    }
    cleaned
}

fn parse_content_disposition_filename(value: &str) -> Option<String> {
    for part in value.split(';') {
        let item = part.trim();
        if let Some(raw) = item.strip_prefix("filename*=") {
            let utf8_raw = raw.trim_start_matches("UTF-8''");
            let decoded = urlencoding::decode(utf8_raw).ok()?.trim().to_string();
            if !decoded.is_empty() {
                return Some(decoded);
            }
        }
    }
    for part in value.split(';') {
        let item = part.trim();
        if let Some(raw) = item.strip_prefix("filename=") {
            let name = raw.trim_matches('"').trim().to_string();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

fn resolve_download_file_name(
    url: &str,
    suggested_file_name: Option<&str>,
    content_disposition: Option<&str>,
) -> String {
    if let Some(name) = suggested_file_name {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            return sanitize_file_name(trimmed);
        }
    }
    if let Some(header) = content_disposition {
        if let Some(name) = parse_content_disposition_filename(header) {
            return sanitize_file_name(&name);
        }
    }
    if let Ok(parsed) = reqwest::Url::parse(url) {
        if let Some(last) = parsed
            .path_segments()
            .and_then(|mut segs| segs.next_back())
            .filter(|s| !s.trim().is_empty())
        {
            return sanitize_file_name(last);
        }
    }
    "download".to_string()
}

fn ensure_unique_download_path(base_dir: &Path, file_name: &str) -> PathBuf {
    let mut candidate = base_dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = Path::new(file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "download".to_string());
    let ext = Path::new(file_name)
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut index = 1u32;
    loop {
        let candidate_name = if ext.is_empty() {
            format!("{stem} ({index})")
        } else {
            format!("{stem} ({index}).{ext}")
        };
        candidate = base_dir.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
        index += 1;
    }
}

#[tauri::command]
async fn download_file_from_url(
    url: String,
    suggested_file_name: Option<String>,
    download_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let id = download_id.unwrap_or_else(|| {
        format!(
            "dl-{}-{}",
            chrono::Utc::now().timestamp_millis(),
            uuid::Uuid::new_v4().simple()
        )
    });
    let emit = |status: &str,
                file_name: &str,
                path: Option<String>,
                received: u64,
                total: Option<u64>,
                error: Option<String>| {
        let _ = app.emit(
            "file-download-progress",
            FileDownloadProgressEvent {
                id: id.clone(),
                url: url.clone(),
                status: status.to_string(),
                file_name: file_name.to_string(),
                path,
                received_bytes: received,
                total_bytes: total,
                error,
            },
        );
    };

    let client = reqwest::Client::new();
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(err) => {
            let msg = format!("下载请求失败: {err}");
            emit("failed", "download", None, 0, None, Some(msg.clone()));
            return Err(msg);
        }
    };
    if !resp.status().is_success() {
        let msg = format!("下载失败: HTTP {}", resp.status().as_u16());
        emit("failed", "download", None, 0, None, Some(msg.clone()));
        return Err(msg);
    }

    let total = resp.content_length();
    let content_disposition = resp
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok());
    let file_name = resolve_download_file_name(&url, suggested_file_name.as_deref(), content_disposition);
    emit("started", &file_name, None, 0, total, None);

    let download_dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "无法获取下载目录".to_string())?;
    if let Err(err) = tokio::fs::create_dir_all(&download_dir).await {
        let msg = format!("创建下载目录失败: {err}");
        emit("failed", &file_name, None, 0, total, Some(msg.clone()));
        return Err(msg);
    }
    let target_path = ensure_unique_download_path(&download_dir, &file_name);
    let path_str = target_path.to_string_lossy().to_string();

    let mut file = match tokio::fs::File::create(&target_path).await {
        Ok(f) => f,
        Err(err) => {
            let msg = format!("创建文件失败: {err}");
            emit("failed", &file_name, Some(path_str), 0, total, Some(msg.clone()));
            return Err(msg);
        }
    };

    let mut received = 0u64;
    let mut stream = resp.bytes_stream();
    while let Some(chunk_res) = stream.next().await {
        let chunk = match chunk_res {
            Ok(c) => c,
            Err(err) => {
                let msg = format!("下载中断: {err}");
                emit("failed", &file_name, Some(path_str.clone()), received, total, Some(msg.clone()));
                return Err(msg);
            }
        };
        if let Err(err) = file.write_all(&chunk).await {
            let msg = format!("写入失败: {err}");
            emit("failed", &file_name, Some(path_str.clone()), received, total, Some(msg.clone()));
            return Err(msg);
        }
        received += chunk.len() as u64;
        emit(
            "downloading",
            &file_name,
            Some(path_str.clone()),
            received,
            total,
            None,
        );
    }

    if let Err(err) = file.flush().await {
        let msg = format!("写入刷新失败: {err}");
        emit("failed", &file_name, Some(path_str.clone()), received, total, Some(msg.clone()));
        return Err(msg);
    }

    emit(
        "completed",
        &file_name,
        Some(path_str.clone()),
        received,
        total,
        None,
    );
    Ok(path_str)
}

#[tauri::command]
async fn set_main_window_size(width: f64, height: f64, app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let scale = win.scale_factor().unwrap_or(1.0);
        let old_size = win.outer_size().map_err(|e| e.to_string())?;
        let old_pos = win.outer_position().map_err(|e| e.to_string())?;

        let old_h = old_size.height as f64 / scale;

        let dy = height - old_h;

        // Keep the bottom-left corner anchored: only shift Y so the pet stays put
        let new_x = old_pos.x as f64 / scale;
        let new_y = old_pos.y as f64 / scale - dy;

        win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
            new_x.max(0.0),
            new_y.max(0.0),
        )))
        .map_err(|e| e.to_string())?;
        win.set_size(Size::Logical(LogicalSize::new(width, height)))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn reveal_main_window_if_hidden(_app: &tauri::AppHandle, _state: &Arc<AppState>) -> Result<(), String> {
    Ok(())
}

fn toggle_main_window_visibility(app: &tauri::AppHandle, state: &Arc<AppState>) -> Result<(), String> {
    let Some(win) = app.get_webview_window("main") else {
        return Ok(());
    };
    if win.is_visible().map_err(|e| e.to_string())? {
        win.hide().map_err(|e| e.to_string())?;
        return Ok(());
    }
    reveal_main_window_if_hidden(app, state)?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

fn normalize_toggle_shortcut(shortcut: &str) -> String {
    let trimmed = shortcut.trim();
    if trimmed.is_empty() {
        DEFAULT_TOGGLE_SHORTCUT.to_string()
    } else {
        trimmed.to_string()
    }
}

fn apply_toggle_shortcut(
    app: &tauri::AppHandle,
    state: &Arc<AppState>,
    shortcut: &str,
) -> Result<String, String> {
    let normalized = normalize_toggle_shortcut(shortcut);
    let mut current = state.visibility_shortcut.lock().map_err(|e| e.to_string())?;
    if current.as_deref() == Some(normalized.as_str()) {
        return Ok(normalized);
    }

    let manager = app.global_shortcut();
    if let Some(prev) = current.clone() {
        let _ = manager.unregister(prev.as_str());
    }

    manager
        .register(normalized.as_str())
        .map_err(|e| format!("register shortcut '{normalized}' failed: {e}"))?;
    *current = Some(normalized.clone());
    Ok(normalized)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cfg = config::load_config().unwrap_or_else(|_| AppConfig {
        bridges: vec![],
        pet: config::PetConfig {
            size: 120,
            always_on_top: true,
            launch_on_startup: false,
            chat_window_opacity: 0.95,
            chat_window_width: 480.0,
            chat_window_height: 640.0,
            toggle_visibility_shortcut: DEFAULT_TOGGLE_SHORTCUT.to_string(),
            appearance: PetAppearanceConfig::default(),
        },
        llm: LlmConfig::default(),
    });

    let history = ChatHistory::new().unwrap_or_else(|err| {
        eprintln!("failed to initialize chat history: {err}");
        std::process::exit(1);
    });

    let state = Arc::new(AppState {
        bridges: Mutex::new(HashMap::new()),
        tunnels: Mutex::new(HashMap::new()),
        bridge_connect_lock: Mutex::new(()),
        history,
        config: Mutex::new(cfg.clone()),
        tray: StdMutex::new(None),
        visibility_shortcut: StdMutex::new(None),
        shutdown_started: StdMutex::new(false),
    });

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler({
                    let state_for_shortcut = state.clone();
                    move |app, _shortcut, event| {
                        if event.state() != ShortcutState::Pressed {
                            return;
                        }
                        if let Err(err) = toggle_main_window_visibility(app, &state_for_shortcut) {
                            eprintln!("global shortcut toggle failed: {err}");
                        }
                    }
                })
                .build(),
        )
        .manage(state.clone())
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);

            if let Err(err) = build_tray(&app.handle(), &state) {
                eprintln!("failed to initialize tray icon: {err}");
            }
            if let Err(err) = apply_toggle_shortcut(&app.handle(), &state, &cfg.pet.toggle_visibility_shortcut) {
                eprintln!("failed to register global shortcut '{}': {err}", cfg.pet.toggle_visibility_shortcut);
            }

            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_always_on_top(cfg.pet.always_on_top);

                #[cfg(target_os = "macos")]
                {
                    use objc2_app_kit::{NSColor, NSWindow};
                    let ns_ptr = win.ns_window().expect("ns_window") as *mut NSWindow;
                    unsafe {
                        let ns_win = &*ns_ptr;
                        ns_win.setBackgroundColor(Some(&NSColor::clearColor()));
                        ns_win.setOpaque(false);
                        ns_win.setHasShadow(false);
                    }
                }

                #[cfg(target_os = "windows")]
                {
                    let _ = win.set_shadow(false);
                }

                let _ = win.center();
                let _ = win.show();
                let _ = win.set_focus();
            }

            if let Err(err) = apply_launch_on_startup(&app.handle(), cfg.pet.launch_on_startup) {
                eprintln!("failed to apply launch on startup: {err}");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            start_ssh_tunnel,
            stop_ssh_tunnel,
            get_ssh_tunnel_status,
            connect_bridge,
            disconnect_bridge,
            get_bridge_status,
            send_message,
            send_card_action,
            send_file,
            send_files,
            get_history,
            clear_history,
            set_always_on_top,
            set_window_opacity,
            set_main_window_size,
            llm_chat,
            llm_generate_image,
            reveal_file,
            quit_app,
            toggle_window_visibility,
            check_for_updates,
            fetch_link_preview,
            download_file_from_url,
            list_bridge_sessions,
            list_local_sessions,
            update_session_label,
            create_bridge_session,
            switch_bridge_session,
            delete_bridge_session,
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|err| {
            eprintln!("error while building tauri application: {err}");
            std::process::exit(1);
        });

    app.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            let state = handle.state::<Arc<AppState>>();
            tauri::async_runtime::block_on(shutdown_network_resources(state.inner()));
        }
    });
}

fn build_tray(app: &tauri::AppHandle, state: &Arc<AppState>) -> Result<(), String> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::TrayIconBuilder;

    let chat = MenuItemBuilder::with_id("chat", "打开聊天")
        .build(app)
        .map_err(|e| e.to_string())?;
    let toggle_visibility = MenuItemBuilder::with_id("toggle_visibility", "隐藏 / 显示")
        .build(app)
        .map_err(|e| e.to_string())?;
    let settings = MenuItemBuilder::with_id("settings", "设置")
        .build(app)
        .map_err(|e| e.to_string())?;
    let check_update = MenuItemBuilder::with_id("check_update", "检查更新")
        .build(app)
        .map_err(|e| e.to_string())?;
    let quit = MenuItemBuilder::with_id("quit", "退出")
        .build(app)
        .map_err(|e| e.to_string())?;

    let menu = MenuBuilder::new(app)
        .item(&chat)
        .item(&toggle_visibility)
        .separator()
        .item(&settings)
        .item(&check_update)
        .separator()
        .item(&quit)
        .build()
        .map_err(|e| e.to_string())?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
        .expect("failed to load tray icon");
    let state_for_menu = Arc::clone(state);

    let tray = TrayIconBuilder::new()
        .icon(icon)
        .tooltip("CC Pet")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "chat" => {
                let _ = app.emit("toggle-chat", ());
                let _ = reveal_main_window_if_hidden(app, &state_for_menu);
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "toggle_visibility" => {
                if let Err(err) = toggle_main_window_visibility(app, &state_for_menu) {
                    eprintln!("toggle visibility failed: {err}");
                }
            }
            "settings" => {
                let _ = app.emit("toggle-settings", ());
                let _ = reveal_main_window_if_hidden(app, &state_for_menu);
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "check_update" => {
                let _ = app.emit("manual-check-updates", ());
                let _ = reveal_main_window_if_hidden(app, &state_for_menu);
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "quit" => {
                let state = app.state::<Arc<AppState>>();
                tauri::async_runtime::block_on(shutdown_network_resources(state.inner()));
                app.exit(0);
            }
            _ => {}
        })
        .build(app)
        .map_err(|e| e.to_string())?;

    let mut tray_slot = state.tray.lock().map_err(|e| e.to_string())?;
    *tray_slot = Some(tray);
    Ok(())
}
