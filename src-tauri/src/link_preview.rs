use futures_util::StreamExt;
use reqwest::redirect::Policy;
use serde::Serialize;

const MAX_HTML_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkPreviewData {
    pub url: String,
    pub final_url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub site_name: Option<String>,
    pub is_file: bool,
    pub file_name: Option<String>,
}

pub async fn fetch(url: &str) -> Result<LinkPreviewData, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid URL".to_string())?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("Only http/https links are supported".into()),
    }

    let client = reqwest::Client::builder()
        .user_agent(concat!(
            "CC-Pet/",
            env!("CARGO_PKG_VERSION"),
            " (link-preview)"
        ))
        .redirect(Policy::limited(8))
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(parsed.clone()).send().await.map_err(|e| e.to_string())?;
    let final_url_obj = resp.url().clone();
    let final_url = final_url_obj.to_string();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let content_disposition = resp
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let mut file_name = content_disposition
        .as_deref()
        .and_then(extract_filename_from_content_disposition)
        .or_else(|| infer_filename_from_url(&final_url_obj));
    file_name = normalize_opt(file_name);
    let looks_like_file = content_disposition
        .as_deref()
        .map(|d| d.to_lowercase().contains("attachment"))
        .unwrap_or(false)
        || file_name.is_some()
        || (!content_type.contains("text/html") && !content_type.contains("application/xhtml"));

    if looks_like_file {
        return Ok(LinkPreviewData {
            url: parsed.to_string(),
            final_url,
            title: file_name.clone(),
            description: None,
            site_name: Some(final_url_obj.host_str().unwrap_or("").to_string()),
            is_file: true,
            file_name,
        });
    }

    let mut body = Vec::with_capacity(16 * 1024);
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        if body.len() >= MAX_HTML_BYTES {
            break;
        }
        let remain = MAX_HTML_BYTES - body.len();
        let take = chunk.len().min(remain);
        body.extend_from_slice(&chunk[..take]);
    }
    let html = String::from_utf8_lossy(&body);
    let title = extract_og_or_title(&html, "og:title")
        .or_else(|| extract_title_tag(&html))
        .or_else(|| file_name.clone());
    let description = extract_og_or_title(&html, "og:description")
        .or_else(|| extract_meta_content_by_name(&html, "description"));
    let site_name = extract_og_or_title(&html, "og:site_name");

    Ok(LinkPreviewData {
        url: parsed.to_string(),
        final_url,
        title: normalize_opt(title),
        description: normalize_opt(description),
        site_name: normalize_opt(site_name),
        is_file: false,
        file_name: None,
    })
}

fn normalize_opt(v: Option<String>) -> Option<String> {
    v.map(|s| collapse_ws(&s).trim().to_string())
        .filter(|s| !s.is_empty())
}

fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_ws = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !prev_ws {
                out.push(' ');
                prev_ws = true;
            }
        } else {
            out.push(ch);
            prev_ws = false;
        }
    }
    out
}

fn extract_title_tag(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let start = lower.find("<title")?;
    let tag_end = lower[start..].find('>')? + start + 1;
    let close = lower[tag_end..].find("</title>")? + tag_end;
    Some(html[tag_end..close].to_string())
}

fn extract_og_or_title(html: &str, property: &str) -> Option<String> {
    for tag in iter_meta_tags(html) {
        let prop = get_attr_value(tag, "property")
            .or_else(|| get_attr_value(tag, "name"))
            .map(|v| v.to_lowercase());
        if prop.as_deref() == Some(property) {
            if let Some(content) = get_attr_value(tag, "content") {
                return Some(content);
            }
        }
    }
    None
}

fn extract_meta_content_by_name(html: &str, name: &str) -> Option<String> {
    for tag in iter_meta_tags(html) {
        let n = get_attr_value(tag, "name").map(|v| v.to_lowercase());
        if n.as_deref() == Some(name) {
            if let Some(content) = get_attr_value(tag, "content") {
                return Some(content);
            }
        }
    }
    None
}

fn iter_meta_tags(html: &str) -> Vec<&str> {
    let lower = html.to_lowercase();
    let mut out = Vec::new();
    let mut pos = 0;
    while let Some(idx) = lower[pos..].find("<meta") {
        let start = pos + idx;
        if let Some(end_rel) = lower[start..].find('>') {
            let end = start + end_rel + 1;
            out.push(&html[start..end]);
            pos = end;
        } else {
            break;
        }
    }
    out
}

fn get_attr_value(tag: &str, attr: &str) -> Option<String> {
    let tag_lower = tag.to_lowercase();
    let needle = format!("{attr}=");
    let idx = tag_lower.find(&needle)?;
    let value_start = idx + needle.len();
    let bytes = tag.as_bytes();
    if value_start >= bytes.len() {
        return None;
    }
    let quote = bytes[value_start] as char;
    if quote == '"' || quote == '\'' {
        let rest = &tag[value_start + 1..];
        let end_rel = rest.find(quote)?;
        return Some(rest[..end_rel].to_string());
    }
    let rest = &tag[value_start..];
    let end_rel = rest.find(|c: char| c.is_whitespace() || c == '>' || c == '/')?;
    Some(rest[..end_rel].to_string())
}

fn infer_filename_from_url(url: &reqwest::Url) -> Option<String> {
    let last = url.path_segments()?.filter(|s| !s.is_empty()).last()?;
    let decoded = decode_percent(last).trim().to_string();
    if decoded.is_empty() {
        return None;
    }
    if decoded.contains('.') {
        return Some(decoded);
    }
    None
}

fn extract_filename_from_content_disposition(value: &str) -> Option<String> {
    for part in value.split(';') {
        let p = part.trim();
        let lower = p.to_lowercase();
        if let Some(raw) = p.strip_prefix("filename*=") {
            let v = raw.trim_matches('"').trim_matches('\'');
            if let Some((_, encoded)) = v.split_once("''") {
                return Some(decode_percent(encoded));
            }
            return Some(decode_percent(v));
        }
        if lower.starts_with("filename=") {
            let raw = p[9..].trim().trim_matches('"').trim_matches('\'');
            return Some(decode_percent(raw));
        }
    }
    None
}

fn decode_percent(input: &str) -> String {
    urlencoding::decode(input)
        .map(|v| v.into_owned())
        .unwrap_or_else(|_| input.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_og_title_and_desc() {
        let html = r#"
            <html><head>
              <meta property="og:title" content="GitHub - zzmzz/cc-pet">
              <meta property="og:description" content="Desktop pet">
              <meta property="og:site_name" content="GitHub">
              <title>fallback</title>
            </head></html>
        "#;
        assert_eq!(
            extract_og_or_title(html, "og:title").as_deref(),
            Some("GitHub - zzmzz/cc-pet")
        );
        assert_eq!(
            extract_og_or_title(html, "og:description").as_deref(),
            Some("Desktop pet")
        );
        assert_eq!(
            extract_og_or_title(html, "og:site_name").as_deref(),
            Some("GitHub")
        );
    }

    #[test]
    fn falls_back_to_title_tag() {
        let html = r#"<html><head><title> Hello   World </title></head></html>"#;
        assert_eq!(normalize_opt(extract_title_tag(html)).as_deref(), Some("Hello World"));
    }

    #[test]
    fn parses_filename_from_content_disposition() {
        let h = "attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95.pdf";
        assert_eq!(
            extract_filename_from_content_disposition(h).as_deref(),
            Some("测试.pdf")
        );
    }
}
