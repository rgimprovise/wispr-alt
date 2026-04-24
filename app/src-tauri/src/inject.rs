//! Text injection into the active application.
//!
//! Strategy: copy the text to the clipboard, then synthesize the
//! platform-native paste shortcut targeting whatever app is frontmost.
//!
//! The synthesis path is platform-specific:
//!
//! * **macOS** — AppleScript via `osascript` + System Events. Uses
//!   `key code 9` (physical V key) so it works regardless of keyboard
//!   layout. Requires Accessibility permission granted to our app once.
//!
//! * **Windows** — `enigo` crate uses `SendInput` under the hood. We send
//!   the raw virtual-key code `VK_V = 0x56` instead of a Unicode 'v' so
//!   Ctrl+V is triggered regardless of the user's keyboard layout.

use arboard::Clipboard;

pub fn paste_text(text: &str) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|e| format!("clipboard init: {e}"))?;
    let previous = clipboard.get_text().ok();

    clipboard
        .set_text(text.to_string())
        .map_err(|e| format!("clipboard set: {e}"))?;

    // Give the OS time to propagate the new pasteboard contents before
    // we fire the paste shortcut.
    std::thread::sleep(std::time::Duration::from_millis(80));

    platform_paste()?;

    // Restore the user's previous clipboard after the paste has landed.
    if let Some(prev) = previous {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let _ = clipboard.set_text(prev);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn platform_paste() -> Result<(), String> {
    use std::process::Command;

    // key code 9 = physical V key. Using `keystroke "v"` breaks on
    // non-Latin keyboard layouts (e.g. on Russian "v" position maps to "м"
    // → Cmd+М, which is unbound).
    let script = r#"tell application "System Events" to key code 9 using {command down}"#;
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("osascript spawn: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("osascript failed: {stderr}"));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn platform_paste() -> Result<(), String> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};

    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("enigo init: {e}"))?;

    // VK_V = 0x56 — physical V. Layout-agnostic Ctrl+V.
    enigo.key(Key::Control, Direction::Press).map_err(|e| format!("ctrl press: {e}"))?;
    enigo.key(Key::Other(0x56), Direction::Click).map_err(|e| format!("V click: {e}"))?;
    enigo.key(Key::Control, Direction::Release).map_err(|e| format!("ctrl release: {e}"))?;
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_paste() -> Result<(), String> {
    Err("paste not implemented for this platform".into())
}
