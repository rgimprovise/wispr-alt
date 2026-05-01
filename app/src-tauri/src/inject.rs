//! Text injection into the active application.
//!
//! Strategy: copy the text to the clipboard, verify the OS clipboard
//! actually reflects our write, then synthesize the platform-native paste
//! shortcut targeting whatever app is frontmost.
//!
//! The synthesis path is platform-specific:
//!
//! * **macOS** — CGEvent posts Cmd+V using physical key code 9 (V), so
//!   layout doesn't matter. Requires Accessibility permission granted
//!   to our app once.
//!
//! * **Windows** — `enigo` (SendInput). Uses VK_V = 0x56 directly.
//!
//! Notes:
//!
//! 1. We verify clipboard contents before firing ⌘V to avoid pasting
//!    stale text on macOS where `arboard.set_text` can return before
//!    NSPasteboard finishes propagating.
//!
//! 2. We DO NOT restore the user's previous clipboard. The naive
//!    "save prev → set ours → paste → restore prev" pattern races: slow
//!    target apps consume ⌘V tens or hundreds of ms after we post it,
//!    by which point we'd already have restored the previous content,
//!    making them paste the wrong thing. Standard paste utilities (e.g.
//!    Raycast, Espanso) leave the new text in the clipboard for the
//!    same reason — predictable behaviour over a "courtesy" restore.

use arboard::Clipboard;
use std::time::{Duration, Instant};

pub fn paste_text(text: &str) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|e| format!("clipboard init: {e}"))?;

    clipboard
        .set_text(text.to_string())
        .map_err(|e| format!("clipboard set: {e}"))?;

    // Spin-wait up to 500 ms until the OS pasteboard reflects our write.
    // arboard.set_text returns synchronously but on macOS the underlying
    // NSPasteboard generation tick can lag a few ms; firing ⌘V before
    // the new generation is visible to the target app makes it paste
    // whatever WAS in the clipboard before, not what we just wrote.
    let deadline = Instant::now() + Duration::from_millis(500);
    let mut verified = false;
    while Instant::now() < deadline {
        if let Ok(current) = clipboard.get_text() {
            if current == text {
                verified = true;
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(8));
    }
    if !verified {
        // One more attempt to set, then proceed regardless. Some macOS
        // clipboard managers steal ownership; retry covers that case.
        let _ = clipboard.set_text(text.to_string());
        std::thread::sleep(Duration::from_millis(40));
    }

    platform_paste()
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
