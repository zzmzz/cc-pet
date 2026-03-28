mod bridge;
mod config;
pub mod history;
mod link_preview;
mod llm;
mod update;

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, LogicalSize, Manager, Size};
use tokio::sync::Mutex;

use bridge::BridgeClient;
use config::{AppConfig, LlmConfig, PetAppearanceConfig};
use history::{ChatHistory, ChatMessage};
use llm::LlmMessage;

struct AppState {
    bridges: Mutex<HashMap<String, BridgeClient>>,
    bridge_connect_lock: Mutex<()>,
    history: ChatHistory,
    config: Mutex<AppConfig>,
    tray: StdMutex<Option<tauri::tray::TrayIcon>>,
}

fn default_session_key(bridge: &config::BridgeConfig) -> String {
    format!(
        "{}:{}:{}",
        bridge.platform_name, bridge.user_id, bridge.user_id
    )
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
async fn save_config(config: AppConfig, state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    config::save_config(&config)?;
    *state.config.lock().await = config;
    Ok(())
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
async fn send_file(
    connection_id: String,
    path: String,
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
        None => {
            eprintln!("[bridge] send_file rejected: no active bridge client");
            return Err("Not connected".into());
        }
    };
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let msg = ChatMessage {
        id: format!("file-{}", chrono::Utc::now().timestamp_millis()),
        connection_id: connection_id.clone(),
        session_key: resolve_session_key(&state, &connection_id, session_key.clone())
            .await
            .unwrap_or_default(),
        role: "user".into(),
        content: name,
        content_type: "file".into(),
        file_path: Some(path.clone()),
        timestamp: chrono::Utc::now().timestamp_millis() as f64,
    };
    if let Err(e) = state.history.add(&msg).await {
        eprintln!("[bridge] history add failed for file, continue sending: {e}");
    }
    let ws_session_key = resolve_session_key(&state, &connection_id, session_key).await;
    client.send_file(path, ws_session_key, reply_ctx).await
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
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path))
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
    app.exit(0);
    Ok(())
}

#[tauri::command]
async fn check_for_updates() -> Result<update::UpdateCheckResult, String> {
    update::check_github_update(env!("CARGO_PKG_VERSION")).await
}

#[tauri::command]
async fn fetch_link_preview(url: String) -> Result<link_preview::LinkPreviewData, String> {
    link_preview::fetch(&url).await
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cfg = config::load_config().unwrap_or_else(|_| AppConfig {
        bridges: vec![],
        pet: config::PetConfig {
            size: 120,
            always_on_top: true,
            chat_window_opacity: 0.95,
            chat_window_width: 480.0,
            chat_window_height: 640.0,
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
        bridge_connect_lock: Mutex::new(()),
        history,
        config: Mutex::new(cfg.clone()),
        tray: StdMutex::new(None),
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(state.clone())
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);

            if let Err(err) = build_tray(&app.handle(), &state) {
                eprintln!("failed to initialize tray icon: {err}");
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

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            connect_bridge,
            disconnect_bridge,
            get_bridge_status,
            send_message,
            send_file,
            get_history,
            clear_history,
            set_always_on_top,
            set_window_opacity,
            set_main_window_size,
            llm_chat,
            llm_generate_image,
            reveal_file,
            quit_app,
            check_for_updates,
            fetch_link_preview,
            list_bridge_sessions,
            list_local_sessions,
            update_session_label,
            create_bridge_session,
            switch_bridge_session,
            delete_bridge_session,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|err| {
            eprintln!("error while running tauri application: {err}");
            std::process::exit(1);
        });
}

fn build_tray(app: &tauri::AppHandle, state: &Arc<AppState>) -> Result<(), String> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::TrayIconBuilder;

    let chat = MenuItemBuilder::with_id("chat", "打开聊天")
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
        .separator()
        .item(&settings)
        .item(&check_update)
        .separator()
        .item(&quit)
        .build()
        .map_err(|e| e.to_string())?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
        .expect("failed to load tray icon");

    let tray = TrayIconBuilder::new()
        .icon(icon)
        .tooltip("CC Pet")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "chat" => {
                let _ = app.emit("toggle-chat", ());
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "settings" => {
                let _ = app.emit("toggle-settings", ());
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "check_update" => {
                let _ = app.emit("manual-check-updates", ());
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "quit" => {
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
