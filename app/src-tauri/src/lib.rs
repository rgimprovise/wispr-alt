mod audio;
mod inject;

use std::sync::Mutex;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};

pub struct AppState {
    pub recorder: Mutex<audio::Recorder>,
}

#[tauri::command]
fn start_recording(
    state: tauri::State<AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    state.recorder.lock().unwrap().start()?;

    // Rust-side ticker for live-preview snapshots. Lives here, not in JS,
    // because macOS WKWebView throttles setInterval when the window is
    // backgrounded — which happens as soon as the user focuses TextEdit
    // to speak. Emits "snapshot-tick" every 2s while recording is active.
    let app_clone = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(2));
        let s = app_clone.state::<AppState>();
        let still_recording = s.recorder.lock().unwrap().is_recording();
        if !still_recording {
            break;
        }
        let _ = app_clone.emit("snapshot-tick", ());
    });

    Ok(())
}

#[tauri::command]
fn stop_recording(state: tauri::State<AppState>) -> Result<Vec<u8>, String> {
    state.recorder.lock().unwrap().stop()
}

#[tauri::command]
fn snapshot_recording(state: tauri::State<AppState>) -> Result<Vec<u8>, String> {
    state.recorder.lock().unwrap().snapshot_wav()
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
                        let _ = app.emit("hotkey-pressed", ());
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Register F5 global shortcut.
            let shortcut = Shortcut::new(None, Code::F5);
            app.global_shortcut().register(shortcut)?;

            // Create floating overlay window. Always-on-top, borderless.
            // Position: top-left corner, 40px from edges (safe area visible
            // on every display). Visible on startup for debugging; later
            // we'll hide when idle.
            let overlay = WebviewWindowBuilder::new(
                app,
                "overlay",
                WebviewUrl::App("overlay.html".into()),
            )
            .title("wispr-alt")
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .inner_size(460.0, 122.0)
            .position(40.0, 60.0)
            .visible(true)
            .build()?;
            // On macOS, floating windows sometimes need an explicit show
            // after build to come to front when always_on_top is set.
            let _ = overlay.show();

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_recording,
            stop_recording,
            snapshot_recording,
            is_recording,
            paste
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
