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

/// One-shot migration of the auth session from plaintext settings.json
/// (v0.3.0 storage) to the OS keychain (v0.3.3+). Idempotent: when the
/// fields are already absent from settings.json this is a no-op.
///
/// Called once on app start. Failure to write to the keychain is logged
/// but doesn't drop the user's session — they stay signed in via the
/// settings.json values until next launch (where we retry).
pub fn migrate_auth_to_keychain(app: &AppHandle) {
    let mut current = load(app);
    let token = current.auth_token.take();
    let email = current.auth_email.take();
    let Some(token) = token else { return };
    let Some(email) = email else { return };
    match crate::keystore::save(&token, &email) {
        Ok(()) => {
            // Strip from disk only after the keychain accepted the value.
            // If save() above failed, we leave the plaintext in place so
            // the user stays signed in and we can retry next launch.
            if let Err(e) = save(app, &current) {
                eprintln!("[settings] migration: failed to strip plaintext: {e}");
            } else {
                eprintln!("[settings] migrated auth session to OS keychain");
            }
        }
        Err(e) => eprintln!("[settings] keychain write failed during migration: {e}"),
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
