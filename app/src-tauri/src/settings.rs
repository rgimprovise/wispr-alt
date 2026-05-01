//! Persistent user settings stored as JSON in the OS's per-user app data dir.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Settings {
    /// Electron-style shortcut string, e.g. "F5", "CmdOrCtrl+Shift+Space".
    pub hotkey: String,
    /// Cleanup style sent to /transcribe. Must match the backend Style union
    /// (clean / business / casual / brief / telegram / email / task).
    #[serde(default = "default_style")]
    pub style: String,
    /// JWT issued by /auth/verify. None until the user signs in. Stored
    /// in plaintext settings.json for now — the file already lives in the
    /// app's per-user data dir, and tokens are short-lived (30d, will be
    /// server-revocable). Move to OS keychain when threat model demands it.
    #[serde(default)]
    pub auth_token: Option<String>,
    /// Email of the signed-in user. Mirrored from the JWT so the UI can
    /// show "Logged in as …" without decoding the token in JS.
    #[serde(default)]
    pub auth_email: Option<String>,
}

fn default_style() -> String {
    "clean".into()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkey: "F5".to_string(),
            style: default_style(),
            auth_token: None,
            auth_email: None,
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    let Ok(path) = settings_path(app) else {
        return Settings::default();
    };
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|err| {
            eprintln!("[settings] failed to parse, using defaults: {err}");
            Settings::default()
        }),
        Err(_) => Settings::default(),
    }
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    let text = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("serialize: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("write {path:?}: {e}"))?;
    Ok(())
}
