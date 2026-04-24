mod audio;
mod inject;
mod perms;
mod settings;

use std::str::FromStr;
use std::sync::Mutex;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub struct AppState {
    pub recorder: Mutex<audio::Recorder>,
    /// Currently-registered global shortcut so we can unregister it when
    /// the user picks a new one.
    pub current_hotkey: Mutex<Option<Shortcut>>,
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

/// Returns true if the app has macOS Accessibility permission. If not,
/// also triggers the system's native prompt (same call does both).
#[tauri::command]
fn check_accessibility() -> bool {
    perms::prompt_accessibility()
}

/// Re-apply NSWindow collection behavior + level on the overlay so it
/// sits above full-screen apps. Called from JS after each show().
///
/// NSWindow mutation must run on the main thread; Tauri command handlers
/// run on an async runtime thread. We dispatch to main via
/// `run_on_main_thread`.
/// Returns the currently-active hotkey string (e.g. "F5", "CmdOrCtrl+Space").
#[tauri::command]
fn get_hotkey(app: tauri::AppHandle) -> String {
    settings::load(&app).hotkey
}

/// Unregister the current global shortcut and register the new one, then
/// persist to disk. The shortcut string must be in the electron-style
/// format that `Shortcut::from_str` understands.
#[tauri::command]
fn set_hotkey(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    combo: String,
) -> Result<(), String> {
    let new_shortcut = Shortcut::from_str(&combo)
        .map_err(|e| format!("invalid shortcut '{combo}': {e}"))?;

    let gs = app.global_shortcut();

    // Unregister the previous shortcut if any.
    {
        let mut cur = state.current_hotkey.lock().unwrap();
        if let Some(old) = cur.take() {
            let _ = gs.unregister(old);
        }
    }

    // Register the new one; restore old on failure.
    gs.register(new_shortcut)
        .map_err(|e| format!("register '{combo}': {e}"))?;
    *state.current_hotkey.lock().unwrap() = Some(new_shortcut);

    // Persist.
    let new_settings = settings::Settings { hotkey: combo.clone() };
    settings::save(&app, &new_settings)?;

    eprintln!("[settings] hotkey set to {combo}");
    Ok(())
}

#[tauri::command]
fn configure_overlay(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    #[cfg(target_os = "macos")]
    {
        let window = app
            .get_webview_window("overlay")
            .ok_or("overlay window not found")?;
        let ns_window = window.ns_window().map_err(|e| e.to_string())?;
        // Raw *mut c_void isn't Send; pass the address as a usize across
        // the thread boundary and reconstitute on the main thread.
        let addr = ns_window as usize;
        app.run_on_main_thread(move || {
            perms::make_overlay_floating_over_fullscreen(addr as *mut std::ffi::c_void);
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            recorder: Mutex::new(audio::Recorder::new()),
            current_hotkey: Mutex::new(None),
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
            // Prompt for macOS Accessibility permission on first launch.
            // This is required for osascript to synthesize Cmd+V into
            // other applications via System Events.
            let trusted = perms::prompt_accessibility();
            eprintln!("[perms] accessibility trusted: {trusted}");

            // Load persisted settings and register the user's chosen hotkey
            // (defaults to F5 on first launch).
            let loaded = settings::load(&app.handle());
            eprintln!("[settings] loaded hotkey: {}", loaded.hotkey);
            let shortcut = Shortcut::from_str(&loaded.hotkey)
                .unwrap_or_else(|_| Shortcut::from_str("F5").unwrap());
            app.global_shortcut().register(shortcut)?;

            let state = app.state::<AppState>();
            *state.current_hotkey.lock().unwrap() = Some(shortcut);

            // Create floating overlay window. Hidden on startup; shown
            // on demand while recording. Key properties:
            //   - always_on_top: floats above other app windows
            //   - visible_on_all_workspaces: appears over full-screen apps
            //     and on every macOS Space (NSWindowCollectionBehavior
            //     CanJoinAllSpaces)
            //   - decorations(false): no titlebar; pure pill
            //   - skip_taskbar: doesn't show in Dock / Alt-Tab
            //   - transparent: lets the pill's rounded glass effect show
            //     through (window corners are transparent)
            let overlay_w = 460.0;
            let overlay_h = 122.0;
            let overlay = WebviewWindowBuilder::new(
                app,
                "overlay",
                WebviewUrl::App("overlay.html".into()),
            )
            .title("wispr-alt")
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false) // don't steal focus from the user's target app
            .inner_size(overlay_w, overlay_h)
            .visible(false) // start hidden — shown on F5
            .build()?;

            // Position at top-center of the primary monitor. Errors here
            // should never abort startup — fall back to the default 0,0.
            if let Ok(Some(monitor)) = app.primary_monitor() {
                let size = monitor.size();
                let scale = monitor.scale_factor();
                let logical_w = size.width as f64 / scale;
                let x = (logical_w - overlay_w) / 2.0;
                let _ = overlay.set_position(tauri::LogicalPosition::new(x, 16.0));
            } else {
                eprintln!("[overlay] primary_monitor unavailable; using default position");
            }

            // macOS: make the overlay appear over full-screen apps and on
            // every Space. Tauri only sets CanJoinAllSpaces via
            // visible_on_all_workspaces; we also need FullScreenAuxiliary
            // and a high window level.
            #[cfg(target_os = "macos")]
            {
                if let Ok(ns_window) = overlay.ns_window() {
                    perms::make_overlay_floating_over_fullscreen(ns_window);
                    eprintln!("[overlay] configured for fullscreen overlay");
                } else {
                    eprintln!("[overlay] ns_window unavailable — overlay may not show over fullscreen apps");
                }
            }

            eprintln!("[overlay] window created: {}", overlay.label());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_recording,
            stop_recording,
            snapshot_recording,
            is_recording,
            paste,
            check_accessibility,
            configure_overlay,
            get_hotkey,
            set_hotkey
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
