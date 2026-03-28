//! Compare local crate version with GitHub Releases latest (same source as README).

use serde::{Deserialize, Serialize};

const GITHUB_REPO: &str = "zzmzz/cc-pet";

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    body: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_url: String,
    pub release_notes: Option<String>,
}

fn normalize_version(s: &str) -> String {
    s.trim()
        .trim_start_matches('v')
        .trim_start_matches('V')
        .to_string()
}

fn is_newer(latest: &str, current: &str) -> bool {
    let l = normalize_version(latest);
    let c = normalize_version(current);
    match (semver::Version::parse(&l), semver::Version::parse(&c)) {
        (Ok(lv), Ok(cv)) => lv > cv,
        _ => false,
    }
}

pub async fn check_github_update(current_version: &str) -> Result<UpdateCheckResult, String> {
    let url = format!(
        "https://api.github.com/repos/{}/releases/latest",
        GITHUB_REPO
    );
    let client = reqwest::Client::builder()
        .user_agent(concat!(
            "CC-Pet/",
            env!("CARGO_PKG_VERSION"),
            " (https://github.com/zzmzz/cc-pet)"
        ))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("GitHub API HTTP {}", resp.status()));
    }

    let rel: GhRelease = resp.json().await.map_err(|e| e.to_string())?;
    let latest_norm = normalize_version(&rel.tag_name);
    let update_available = is_newer(&rel.tag_name, current_version);

    Ok(UpdateCheckResult {
        current_version: current_version.to_string(),
        latest_version: latest_norm,
        update_available,
        release_url: rel.html_url,
        release_notes: rel.body.filter(|b| !b.trim().is_empty()),
    })
}
