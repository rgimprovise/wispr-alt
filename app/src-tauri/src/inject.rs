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
    // Synthesize Cmd+V directly via CGEvent. This avoids shelling out to
    // osascript (which spawns System Events as a separate process and
    // subjects THAT process to its own Accessibility check — which is
    // what we were hitting with the "keystrokes for osascript not
    // allowed" error). With CGEvent, the TCC check is against our own
    // process, for which the user has already granted Accessibility.
    //
    // Key code 9 is the physical V key, layout-agnostic.
    use core_graphics::event::{
        CGEvent, CGEventFlags, CGEventTapLocation, CGKeyCode,
    };
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    const KEY_V: CGKeyCode = 9;
    const TAP: CGEventTapLocation = CGEventTapLocation::HID;

    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "CGEventSource::new failed".to_string())?;

    let down = CGEvent::new_keyboard_event(source.clone(), KEY_V, true)
        .map_err(|_| "keyboard down event failed".to_string())?;
    down.set_flags(CGEventFlags::CGEventFlagCommand);
    down.post(TAP);

    let up = CGEvent::new_keyboard_event(source, KEY_V, false)
        .map_err(|_| "keyboard up event failed".to_string())?;
    up.set_flags(CGEventFlags::CGEventFlagCommand);
    up.post(TAP);

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
