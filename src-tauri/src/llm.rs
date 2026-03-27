use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Emitter;

use crate::config::LlmConfig;

/// Normalize base URL for OpenAI-compatible APIs.
/// - `https://api.openai.com/v1` → unchanged
/// - `https://host/doubao` → `https://host/doubao/v1`
fn openai_compatible_base(api_url: &str) -> String {
    let base = api_url.trim().trim_end_matches('/');
    if base.ends_with("/v1") {
        base.to_string()
    } else {
        format!("{}/v1", base)
    }
}

fn chat_completions_url(api_url: &str) -> String {
    format!("{}/chat/completions", openai_compatible_base(api_url))
}

fn multimodal_generation_url(api_url: &str) -> String {
    format!(
        "{}/services/aigc/multimodal-generation/generation",
        openai_compatible_base(api_url)
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmMessage {
    pub role: String,
    pub content: String,
}

pub async fn chat_stream(
    cfg: &LlmConfig,
    messages: Vec<LlmMessage>,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    let url = chat_completions_url(&cfg.api_url);

    let body = json!({
        "model": &cfg.model,
        "messages": messages,
        "stream": true,
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("LLM request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("LLM API error {status}: {text}"));
    }

    let mut full_text = String::new();
    let mut stream = resp.bytes_stream();

    use futures_util::StreamExt;
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream read error: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if line.is_empty() || line == "data: [DONE]" {
                continue;
            }

            if let Some(data) = line.strip_prefix("data: ") {
                if let Ok(val) = serde_json::from_str::<Value>(data) {
                    if let Some(delta) = val
                        .get("choices")
                        .and_then(|c| c.get(0))
                        .and_then(|c| c.get("delta"))
                        .and_then(|d| d.get("content"))
                        .and_then(|c| c.as_str())
                    {
                        full_text.push_str(delta);
                        let _ = app.emit("llm-stream-delta", delta);
                    }
                }
            }
        }
    }

    let _ = app.emit("llm-stream-done", &full_text);
    Ok(full_text)
}

/// Generate image using DashScope multimodal-generation API (sync).
/// The API URL should point to the DashScope-compatible endpoint base,
/// e.g. "https://dashscope.aliyuncs.com/api/v1" or a proxy like
/// "https://all-in-one-ai.fintopia.tech/qwen/v1".
pub async fn generate_image(
    cfg: &LlmConfig,
    prompt: &str,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    let image_model = cfg.image_model.as_deref().unwrap_or("qwen-image-2.0");

    let url = multimodal_generation_url(&cfg.api_url);

    let body = json!({
        "model": image_model,
        "input": {
            "messages": [
                {
                    "role": "user",
                    "content": [{ "text": prompt }]
                }
            ]
        },
        "parameters": {
            "size": "1024*1024",
            "n": 1,
            "watermark": false,
            "prompt_extend": true,
        }
    });

    let _ = app.emit("llm-image-progress", "正在生成图片...");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Image generation request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Image API error {status}: {text}"));
    }

    let val: Value = resp.json().await.map_err(|e| format!("Parse error: {e}"))?;

    // DashScope sync response: output.choices[0].message.content[0].image
    if let Some(image_url) = val
        .get("output")
        .and_then(|o| o.get("choices"))
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.get(0))
        .and_then(|i| i.get("image"))
        .and_then(|u| u.as_str())
    {
        return Ok(image_url.to_string());
    }

    // OpenAI images/generations response: data[0].url
    if let Some(image_url) = val
        .get("data")
        .and_then(|d| d.get(0))
        .and_then(|d| d.get("url"))
        .and_then(|u| u.as_str())
    {
        return Ok(image_url.to_string());
    }

    Err(format!(
        "No image URL in response: {}",
        serde_json::to_string_pretty(&val).unwrap_or_default()
    ))
}
