use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub bridge: BridgeConfig,
    pub pet: PetConfig,
    #[serde(default)]
    pub llm: LlmConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeConfig {
    pub host: String,
    pub port: u16,
    pub token: String,
    pub platform_name: String,
    pub user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PetAppearanceConfig {
    #[serde(default)]
    pub idle: Option<String>,
    #[serde(default)]
    pub thinking: Option<String>,
    #[serde(default)]
    pub talking: Option<String>,
    #[serde(default)]
    pub happy: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetConfig {
    pub size: u32,
    pub always_on_top: bool,
    pub chat_window_opacity: f64,
    #[serde(default = "default_chat_window_width")]
    pub chat_window_width: f64,
    #[serde(default = "default_chat_window_height")]
    pub chat_window_height: f64,
    #[serde(default)]
    pub appearance: PetAppearanceConfig,
}

fn default_chat_window_width() -> f64 { 480.0 }
fn default_chat_window_height() -> f64 { 640.0 }

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    #[serde(default)]
    pub api_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub image_model: Option<String>,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
struct TomlConfig {
    bridge: TomlBridge,
    pet: Option<TomlPet>,
    llm: Option<TomlLlm>,
}

#[derive(Debug, Deserialize)]
struct TomlBridge {
    host: Option<String>,
    port: u16,
    token: String,
    platform_name: Option<String>,
    user_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TomlPet {
    size: Option<u32>,
    always_on_top: Option<bool>,
    chat_window_opacity: Option<f64>,
    chat_window_width: Option<f64>,
    chat_window_height: Option<f64>,
    appearance: Option<TomlPetAppearance>,
}

#[derive(Debug, Deserialize, Default)]
struct TomlPetAppearance {
    idle: Option<String>,
    thinking: Option<String>,
    talking: Option<String>,
    happy: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TomlLlm {
    api_url: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    image_model: Option<String>,
    enabled: Option<bool>,
}

pub fn config_path() -> PathBuf {
    let dir = dirs_next().join("cc-pet");
    fs::create_dir_all(&dir).ok();
    dir.join("config.toml")
}

fn dirs_next() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|t| !t.trim().is_empty())
}

/// TOML single-quoted literal (safe for Windows paths).
fn toml_single_quoted(s: &str) -> String {
    let escaped = s.replace('\'', "''");
    format!("'{escaped}'")
}

fn parse_pet_and_llm(pet: Option<TomlPet>, llm: Option<TomlLlm>) -> (PetConfig, LlmConfig) {
    let pet = pet.unwrap_or(TomlPet {
        size: None,
        always_on_top: None,
        chat_window_opacity: None,
        chat_window_width: None,
        chat_window_height: None,
        appearance: None,
    });
    let llm = llm.unwrap_or(TomlLlm {
        api_url: None,
        api_key: None,
        model: None,
        image_model: None,
        enabled: None,
    });
    let app_toml = pet.appearance.unwrap_or_default();
    let appearance = PetAppearanceConfig {
        idle: non_empty(app_toml.idle),
        thinking: non_empty(app_toml.thinking),
        talking: non_empty(app_toml.talking),
        happy: non_empty(app_toml.happy),
        error: non_empty(app_toml.error),
    };
    let pet_cfg = PetConfig {
        size: pet.size.unwrap_or(120),
        always_on_top: pet.always_on_top.unwrap_or(true),
        chat_window_opacity: pet.chat_window_opacity.unwrap_or(0.95),
        chat_window_width: pet.chat_window_width.unwrap_or(480.0),
        chat_window_height: pet.chat_window_height.unwrap_or(640.0),
        appearance,
    };
    let llm_cfg = LlmConfig {
        api_url: llm.api_url.unwrap_or_default(),
        api_key: llm.api_key.unwrap_or_default(),
        model: llm.model.unwrap_or_default(),
        image_model: llm.image_model,
        enabled: llm.enabled.unwrap_or(false),
    };
    (pet_cfg, llm_cfg)
}

pub fn load_config() -> Result<AppConfig, String> {
    let path = config_path();
    if !path.exists() {
        return Ok(default_config());
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let toml: TomlConfig = toml::from_str(&text).map_err(|e| e.to_string())?;
    let (pet, llm) = parse_pet_and_llm(toml.pet, toml.llm);
    Ok(AppConfig {
        bridge: BridgeConfig {
            host: toml.bridge.host.unwrap_or_else(|| "127.0.0.1".into()),
            port: toml.bridge.port,
            token: toml.bridge.token,
            platform_name: toml.bridge.platform_name.unwrap_or_else(|| "desktop-pet".into()),
            user_id: toml.bridge.user_id.unwrap_or_else(|| "pet-user".into()),
        },
        pet,
        llm,
    })
}

pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let image_model_line = match &config.llm.image_model {
        Some(m) if !m.is_empty() => format!("image_model = \"{}\"", m),
        _ => String::new(),
    };
    let mut appearance_block = String::new();
    let a = &config.pet.appearance;
    if let Some(ref p) = non_empty(a.idle.clone()) {
        appearance_block.push_str(&format!("idle = {}\n", toml_single_quoted(p)));
    }
    if let Some(ref p) = non_empty(a.thinking.clone()) {
        appearance_block.push_str(&format!("thinking = {}\n", toml_single_quoted(p)));
    }
    if let Some(ref p) = non_empty(a.talking.clone()) {
        appearance_block.push_str(&format!("talking = {}\n", toml_single_quoted(p)));
    }
    if let Some(ref p) = non_empty(a.happy.clone()) {
        appearance_block.push_str(&format!("happy = {}\n", toml_single_quoted(p)));
    }
    if let Some(ref p) = non_empty(a.error.clone()) {
        appearance_block.push_str(&format!("error = {}\n", toml_single_quoted(p)));
    }
    let appearance_section = if appearance_block.is_empty() {
        String::new()
    } else {
        format!("\n[pet.appearance]\n{}", appearance_block)
    };
    let content = format!(
        r#"[bridge]
host = "{}"
port = {}
token = "{}"
platform_name = "{}"
user_id = "{}"

[pet]
size = {}
always_on_top = {}
chat_window_opacity = {}
chat_window_width = {}
chat_window_height = {}{}

[llm]
api_url = "{}"
api_key = "{}"
model = "{}"
{}
enabled = {}
"#,
        config.bridge.host,
        config.bridge.port,
        config.bridge.token,
        config.bridge.platform_name,
        config.bridge.user_id,
        config.pet.size,
        config.pet.always_on_top,
        config.pet.chat_window_opacity,
        config.pet.chat_window_width,
        config.pet.chat_window_height,
        appearance_section,
        config.llm.api_url,
        config.llm.api_key,
        config.llm.model,
        image_model_line,
        config.llm.enabled,
    );
    let path = config_path();
    fs::write(&path, content).map_err(|e| e.to_string())
}

fn default_config() -> AppConfig {
    AppConfig {
        bridge: BridgeConfig {
            host: "127.0.0.1".into(),
            port: 9810,
            token: String::new(),
            platform_name: "desktop-pet".into(),
            user_id: "pet-user".into(),
        },
        pet: PetConfig {
            size: 120,
            always_on_top: true,
            chat_window_opacity: 0.95,
            chat_window_width: 480.0,
            chat_window_height: 640.0,
            appearance: PetAppearanceConfig::default(),
        },
        llm: LlmConfig::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_empty_filters_whitespace_only() {
        assert_eq!(non_empty(None), None);
        assert_eq!(non_empty(Some("".into())), None);
        assert_eq!(non_empty(Some("   \t\n".into())), None);
        assert_eq!(non_empty(Some(" x ".into())), Some(" x ".into()));
    }

    #[test]
    fn toml_single_quoted_escapes_apostrophe() {
        assert_eq!(toml_single_quoted("a'b"), "'a''b'");
        assert_eq!(toml_single_quoted(""), "''");
        assert_eq!(toml_single_quoted("plain"), "'plain'");
    }

    #[test]
    fn parse_pet_and_llm_defaults_when_inputs_none() {
        let (pet, llm) = parse_pet_and_llm(None, None);
        assert_eq!(pet.size, 120);
        assert!(pet.always_on_top);
        assert!((pet.chat_window_opacity - 0.95).abs() < f64::EPSILON);
        assert!((pet.chat_window_width - 480.0).abs() < f64::EPSILON);
        assert!((pet.chat_window_height - 640.0).abs() < f64::EPSILON);
        assert!(pet.appearance.idle.is_none());
        assert!(llm.api_url.is_empty());
        assert!(!llm.enabled);
    }

    #[test]
    fn parse_pet_and_llm_filters_blank_appearance_strings() {
        let pet = TomlPet {
            size: None,
            always_on_top: None,
            chat_window_opacity: None,
            chat_window_width: None,
            chat_window_height: None,
            appearance: Some(TomlPetAppearance {
                idle: Some("   ".into()),
                thinking: Some("ok".into()),
                talking: None,
                happy: Some("".into()),
                error: Some("\n\t".into()),
            }),
        };
        let (pet_cfg, _) = parse_pet_and_llm(Some(pet), None);
        assert!(pet_cfg.appearance.idle.is_none());
        assert_eq!(pet_cfg.appearance.thinking.as_deref(), Some("ok"));
        assert!(pet_cfg.appearance.talking.is_none());
        assert!(pet_cfg.appearance.happy.is_none());
        assert!(pet_cfg.appearance.error.is_none());
    }
}
