use arboard::Clipboard;
use std::process::Command;

/// Put `text` on the clipboard, then synthesize Cmd+V in the currently-active
/// application using AppleScript via System Events. More reliable than enigo on
/// macOS: uses the same permission model as the built-in accessibility tooling
/// and doesn't silently drop events.
///
/// Requires: first invocation prompts the user to allow Automation →
/// "app" controlling "System Events" (System Settings → Privacy & Security →
/// Automation).
pub fn paste_text(text: &str) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|e| format!("clipboard init: {e}"))?;
    let previous = clipboard.get_text().ok();

    clipboard
        .set_text(text.to_string())
        .map_err(|e| format!("clipboard set: {e}"))?;

    // Small delay so the pasteboard propagates before Cmd+V fires.
    std::thread::sleep(std::time::Duration::from_millis(80));

    // key code 9 = physical V key. Using `keystroke "v"` breaks on non-Latin
    // keyboard layouts (e.g. on Russian "v" position maps to "м" → Cmd+М).
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

    // Restore previous clipboard after paste has settled.
    if let Some(prev) = previous {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let _ = clipboard.set_text(prev);
    }
    Ok(())
}
