mod audio;
mod inject;

use std::sync::Mutex;
use tauri::Emitter;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};

pub struct AppState {
    pub recorder: Mutex<audio::Recorder>,
}

#[tauri::command]
fn start_recording(state: tauri::State<AppState>) -> Result<(), String> {
    state.recorder.lock().unwrap().start()
}

#[tauri::command]
fn stop_recording(state: tauri::State<AppState>) -> Result<Vec<u8>, String> {
    state.recorder.lock().unwrap().stop()
}

#[tauri::command]
fn is_recording(state: tauri::State<AppState>) -> bool {
    state.recorder.lock().unwrap().is_recording()
}

#[tauri::command]
fn paste(text: String) -> Result<(), String> {
    inject::paste_text(&text)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            recorder: Mutex::new(audio::Recorder::new()),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        // JS owns the state machine. We just notify.
                        let _ = app.emit("hotkey-pressed", ());
                    }
                })
                .build(),
        )
        .setup(|app| {
            let shortcut = Shortcut::new(None, Code::F5);
            app.global_shortcut().register(shortcut)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_recording,
            stop_recording,
            is_recording,
            paste
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
