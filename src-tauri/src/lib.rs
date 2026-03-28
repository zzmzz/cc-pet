mod bridge;
mod config;
mod history;
mod llm;

use std::sync::{Arc, Mutex as StdMutex};
use tauri::{Emitter, LogicalSize, Manager, Size};
use tokio::sync::Mutex;

use bridge::BridgeClient;
use config::{AppConfig, LlmConfig, PetAppearanceConfig};
use history::{ChatHistory, ChatMessage};
use llm::LlmMessage;

struct AppState {
    bridge: Mutex<Option<BridgeClient>>,
    bridge_connect_lock: Mutex<()>,
    history: ChatHistory,
    config: Mutex<AppConfig>,
    tray: StdMutex<Option<tauri::tray::TrayIcon>>,
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
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let _connect_guard = state.bridge_connect_lock.lock().await;
    let cfg = state.config.lock().await.clone();
    if cfg.bridge.token.is_empty() {
        return Err("Token is empty — configure Bridge first".into());
    }
    {
        let guard = state.bridge.lock().await;
        if guard.is_some() {
            eprintln!("[bridge] connect requested but client already exists; skip");
            return Ok(());
        }
    }
    let prev = {
        let mut guard = state.bridge.lock().await;
        guard.take()
    };
    if let Some(prev) = prev {
        eprintln!("[bridge] stopping previous client before reconnect");
        prev.stop().await;
    }
    eprintln!(
        "[bridge] starting client host={} port={} platform={}",
        cfg.bridge.host, cfg.bridge.port, cfg.bridge.platform_name
    );
    let client = BridgeClient::start(cfg.bridge, app);
    *state.bridge.lock().await = Some(client);
    Ok(())
}

#[tauri::command]
async fn disconnect_bridge(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    let _connect_guard = state.bridge_connect_lock.lock().await;
    if let Some(client) = state.bridge.lock().await.as_ref() {
        eprintln!("[bridge] disconnect requested");
        client.stop().await;
    }
    *state.bridge.lock().await = None;
    Ok(())
}

#[tauri::command]
async fn get_bridge_connected(state: tauri::State<'_, Arc<AppState>>) -> Result<bool, String> {
    let guard = state.bridge.lock().await;
    Ok(guard.as_ref().map(|c| c.is_connected()).unwrap_or(false))
}

#[tauri::command]
async fn send_message(
    text: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    eprintln!("[bridge] send_message called, len={}", text.len());
    let guard = state.bridge.lock().await;
    let client = match guard.as_ref() {
        Some(c) => c,
        None => {
            eprintln!("[bridge] send_message rejected: no active bridge client");
            return Err("Not connected".into());
        }
    };
    // save to history
    let msg = ChatMessage {
        id: format!("user-{}", chrono::Utc::now().timestamp_millis()),
        role: "user".into(),
        content: text.clone(),
        content_type: "text".into(),
        file_path: None,
        timestamp: chrono::Utc::now().timestamp_millis() as f64,
    };
    if let Err(e) = state.history.add(&msg) {
        eprintln!("[bridge] history add failed, continue sending: {e}");
    }
    let result = client.send_text(text).await;
    if let Err(ref e) = result {
        eprintln!("[bridge] send_message enqueue failed: {e}");
    } else {
        eprintln!("[bridge] send_message enqueued");
    }
    result
}

#[tauri::command]
async fn send_file(
    path: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let guard = state.bridge.lock().await;
    let client = match guard.as_ref() {
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
        role: "user".into(),
        content: name,
        content_type: "file".into(),
        file_path: Some(path.clone()),
        timestamp: chrono::Utc::now().timestamp_millis() as f64,
    };
    if let Err(e) = state.history.add(&msg) {
        eprintln!("[bridge] history add failed for file, continue sending: {e}");
    }
    client.send_file(path).await
}

#[tauri::command]
async fn get_history(
    limit: u32,
    before_id: Option<String>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<ChatMessage>, String> {
    state.history.recent(limit, before_id.as_deref())
}

#[tauri::command]
async fn clear_history(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    state.history.clear()
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
async fn set_main_window_size(width: f64, height: f64, app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let scale = win.scale_factor().unwrap_or(1.0);
        let old_size = win.outer_size().map_err(|e| e.to_string())?;
        let old_pos = win.outer_position().map_err(|e| e.to_string())?;

        let old_w = old_size.width as f64 / scale;
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
        bridge: config::BridgeConfig {
            host: "127.0.0.1".into(),
            port: 9810,
            token: String::new(),
            platform_name: "desktop-pet".into(),
            user_id: "pet-user".into(),
        },
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
        bridge: Mutex::new(None),
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
            get_bridge_connected,
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
    let quit = MenuItemBuilder::with_id("quit", "退出")
        .build(app)
        .map_err(|e| e.to_string())?;

    let menu = MenuBuilder::new(app)
        .item(&chat)
        .separator()
        .item(&settings)
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
