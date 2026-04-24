use arboard::Clipboard;
use enigo::{Direction, Enigo, Key, Keyboard, Settings};

pub fn paste_text(text: &str) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    let previous = clipboard.get_text().ok();

    clipboard
        .set_text(text.to_string())
        .map_err(|e| e.to_string())?;

    std::thread::sleep(std::time::Duration::from_millis(60));

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    enigo
        .key(Key::Meta, Direction::Press)
        .map_err(|e| e.to_string())?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| e.to_string())?;
    enigo
        .key(Key::Meta, Direction::Release)
        .map_err(|e| e.to_string())?;

    if let Some(prev) = previous {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let _ = clipboard.set_text(prev);
    }
    Ok(())
}
