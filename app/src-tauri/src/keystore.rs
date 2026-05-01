//! OS-native secret storage for the auth JWT + email.
//!
//! Wraps `keyring` so the rest of the app reads "the token" without
//! caring whether it lives in macOS Keychain, Windows Credential Manager,
//! or Linux Secret Service.
//!
//! `keyring::Error::NoEntry` collapses to `Ok(None)` — that's the normal
//! "not signed in yet" case, not a real failure.

use keyring::Entry;

const SERVICE: &str = "app.agolos";
const KEY_TOKEN: &str = "auth_token";
const KEY_EMAIL: &str = "auth_email";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| format!("keyring entry({key}): {e}"))
}

fn read(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring get({key}): {e}")),
    }
}

fn write(key: &str, value: &str) -> Result<(), String> {
    entry(key)?
        .set_password(value)
        .map_err(|e| format!("keyring set({key}): {e}"))
}

fn delete(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete({key}): {e}")),
    }
}

pub fn get_token() -> Result<Option<String>, String> {
    read(KEY_TOKEN)
}

pub fn get_email() -> Result<Option<String>, String> {
    read(KEY_EMAIL)
}

pub fn save(token: &str, email: &str) -> Result<(), String> {
    write(KEY_TOKEN, token)?;
    write(KEY_EMAIL, email)?;
    Ok(())
}

pub fn clear() -> Result<(), String> {
    // Errors on either key shouldn't block the other — log and continue.
    if let Err(e) = delete(KEY_TOKEN) {
        eprintln!("[keystore] {e}");
    }
    if let Err(e) = delete(KEY_EMAIL) {
        eprintln!("[keystore] {e}");
    }
    Ok(())
}
