mod audio;
mod inject;
mod keystore;
mod perms;
mod settings;

use std::str::FromStr;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_deep_link::DeepLinkExt;
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
    streaming: Option<bool>,
) -> Result<(), String> {
    state.recorder.lock().unwrap().start()?;

    // Rust-side ticker for the JS audio loop. Lives here, not in JS,
    // because macOS WKWebView throttles setInterval when the window is
    // backgrounded — which happens as soon as the user focuses TextEdit
    // to speak.
    //
    // - streaming=false (default): emits "snapshot-tick" every 2s; JS
    //   pulls the WAV and POSTs to /transcribe?postprocess=false for a
    //   coarse live preview. Legacy path, kept as fallback.
    // - streaming=true: emits "stream-pull-tick" every 100ms; JS pulls
    //   PCM16 16kHz chunks and forwards as binary frames over the
    //   /transcribe-stream WebSocket.
    let stream = streaming.unwrap_or(false);
    let (event, period) = if stream {
        ("stream-pull-tick", std::time::Duration::from_millis(100))
    } else {
        // 1 s tick gives partial-text refresh at ~1.5–2 s latency
        // (1 s tick + ~700 ms HTTP transcription on the rolling 5 s
        // window). 2 s was the v0.3 default, but felt sluggish.
        ("snapshot-tick", std::time::Duration::from_secs(1))
    };
    let app_clone = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(period);
        let s = app_clone.state::<AppState>();
        let still_recording = s.recorder.lock().unwrap().is_recording();
        if !still_recording {
            break;
        }
        let _ = app_clone.emit(event, ());
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

/// Last `seconds` of audio as WAV. Live-preview ticker uses this with a
/// 5-second window so partials don't slow down on long recordings.
#[tauri::command]
fn snapshot_recent(
    state: tauri::State<AppState>,
    seconds: u32,
) -> Result<Vec<u8>, String> {
    state.recorder.lock().unwrap().snapshot_recent_wav(seconds)
}

/// Returns new mic samples since the previous call as PCM16 mono 16 kHz
/// LE bytes. Driven by the JS streaming layer: poll every ~100 ms and
/// forward the bytes verbatim as a binary WS frame.
#[tauri::command]
fn pull_pcm16_chunk(state: tauri::State<AppState>) -> Vec<u8> {
    state.recorder.lock().unwrap().pull_pcm16_16k_chunk()
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

const VALID_STYLES: &[&str] = &[
    "clean", "business", "casual", "brief", "telegram", "email", "task",
];

/// Returns the user's preferred cleanup style (e.g. "clean", "business").
#[tauri::command]
fn get_style(app: tauri::AppHandle) -> String {
    settings::load(&app).style
}

// ─── Auth session storage ─────────────────────────────────────────────────
//
// All HTTP to /auth/* lives in the JS layer (it already has BACKEND_URL
// and fetch). These Rust commands just persist the resulting JWT + email
// to the same settings.json other prefs use.

/// Returns the stored JWT. Reads OS keychain first; if unavailable
/// (unsigned dev binaries on macOS lose keychain ACL between rebuilds,
/// fresh Linux installs without a configured Secret Service, etc.)
/// falls back to settings.json which is always writable.
#[tauri::command]
fn get_auth_token(app: tauri::AppHandle) -> Option<String> {
    match keystore::get_token() {
        Ok(Some(t)) => {
            eprintln!("[auth] token from keychain");
            Some(t)
        }
        Ok(None) => {
            let from_settings = settings::load(&app).auth_token;
            if from_settings.is_some() {
                eprintln!("[auth] token from settings.json fallback");
            } else {
                eprintln!("[auth] no token (neither keychain nor settings)");
            }
            from_settings
        }
        Err(e) => {
            eprintln!("[auth] keychain read failed ({e}); using settings.json");
            settings::load(&app).auth_token
        }
    }
}

#[tauri::command]
fn get_auth_email(app: tauri::AppHandle) -> Option<String> {
    match keystore::get_email() {
        Ok(Some(e)) => Some(e),
        Ok(None) => settings::load(&app).auth_email,
        Err(e) => {
            eprintln!("[auth] keychain read failed ({e}); using settings.json");
            settings::load(&app).auth_email
        }
    }
}

/// Persists the session. Writes to BOTH keychain and settings.json so
/// either store can serve as the source of truth on the next boot.
/// Trade-off: settings.json stays a plaintext mirror, but it's already
/// in the app's per-user data dir and the JWT is short-lived.
#[tauri::command]
fn set_auth_session(
    app: tauri::AppHandle,
    token: String,
    email: String,
) -> Result<(), String> {
    let kc = keystore::save(&token, &email);
    if let Err(ref e) = kc {
        eprintln!("[auth] keychain write failed: {e}");
    }
    // Always mirror to settings.json — cheap and survives keychain loss.
    let mut current = settings::load(&app);
    current.auth_token = Some(token);
    current.auth_email = Some(email);
    settings::save(&app, &current)?;
    if kc.is_ok() {
        eprintln!("[auth] session stored (keychain + settings)");
    } else {
        eprintln!("[auth] session stored (settings only — keychain unavailable)");
    }
    Ok(())
}

#[tauri::command]
fn clear_auth_session(app: tauri::AppHandle) -> Result<(), String> {
    let _ = keystore::clear();
    let mut current = settings::load(&app);
    current.auth_token = None;
    current.auth_email = None;
    settings::save(&app, &current)?;
    eprintln!("[auth] session cleared");
    Ok(())
}

/// Persists the user's chosen cleanup style. Validates against the known
/// list; unknown values are rejected.
#[tauri::command]
fn set_style(app: tauri::AppHandle, style: String) -> Result<(), String> {
    if !VALID_STYLES.contains(&style.as_str()) {
        return Err(format!("unknown style '{style}'"));
    }
    let mut current = settings::load(&app);
    current.style = style.clone();
    settings::save(&app, &current)?;
    eprintln!("[settings] style set to {style}");
    Ok(())
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

    // Persist (preserve other settings fields like style).
    let mut current = settings::load(&app);
    current.hotkey = combo.clone();
    settings::save(&app, &current)?;

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

// ─── Tray helpers ─────────────────────────────────────────────────────────

fn bring_main_to_front(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        match w.is_visible() {
            Ok(true) => { let _ = w.hide(); }
            _ => {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }
    }
}

fn quit_app(app: &tauri::AppHandle) {
    eprintln!("[lifecycle] quit requested via tray");
    if let Some(state) = app.try_state::<AppState>() {
        let mut rec = state.recorder.lock().unwrap();
        if rec.is_recording() {
            let _ = rec.stop();
        }
    }
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            recorder: Mutex::new(audio::Recorder::new()),
            current_hotkey: Mutex::new(None),
        })
        // single-instance MUST be the first plugin: when a second copy of
        // the app is launched (e.g. user clicks agolos://auth from a
        // browser), this routes the URL to the running instance instead
        // of spawning a duplicate.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Bring the existing window forward so the user sees the
            // sign-in succeed. The deep-link plugin (registered below)
            // delivers the URL itself via on_open_url.
            bring_main_to_front(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
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
            // One-shot migration of v0.3.0 plaintext tokens (settings.json)
            // into the OS keychain. Idempotent for fresh installs and
            // post-migration launches.
            settings::migrate_auth_to_keychain(&app.handle());

            // Register the agolos:// scheme at runtime. Bundled releases
            // get this through Info.plist / WiX / .desktop files generated
            // by tauri build, but dev mode (`bun tauri dev`) needs explicit
            // registration to receive deep links. Cheap no-op when already
            // registered.
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                let _ = app.deep_link().register("agolos");
            }

            // Magic-link deep links. When the user clicks the email's
            // agolos://auth?token=…&email=… URL we save the session and
            // emit "auth-deep-link" so the JS layer flips out of the
            // login gate. Both fresh-launch and already-running cases
            // funnel through this same callback.
            let app_for_dl = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if url.scheme() != "agolos" || url.host_str() != Some("auth") {
                        continue;
                    }
                    let mut token: Option<String> = None;
                    let mut email: Option<String> = None;
                    for (k, v) in url.query_pairs() {
                        match k.as_ref() {
                            "token" => token = Some(v.into_owned()),
                            "email" => email = Some(v.into_owned()),
                            _ => {}
                        }
                    }
                    let Some(token) = token else { continue };
                    let final_email = email
                        .or_else(|| keystore::get_email().ok().flatten())
                        .or_else(|| settings::load(&app_for_dl).auth_email)
                        .unwrap_or_default();
                    // Same dual-write policy as set_auth_session: keychain
                    // best-effort, settings.json as durable mirror.
                    if let Err(e) = keystore::save(&token, &final_email) {
                        eprintln!("[deep-link] keychain save failed: {e}");
                    }
                    let mut s = settings::load(&app_for_dl);
                    s.auth_token = Some(token.clone());
                    s.auth_email = Some(final_email.clone());
                    if let Err(e) = settings::save(&app_for_dl, &s) {
                        eprintln!("[deep-link] settings save failed: {e}");
                        continue;
                    }
                    let _ = app_for_dl.emit(
                        "auth-deep-link",
                        serde_json::json!({ "token": token, "email": final_email }),
                    );
                    bring_main_to_front(&app_for_dl);
                }
            });

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
            .title("А-ГОЛОС")
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

            // System tray: keeps the app alive when the user closes the
            // main window. Left-click toggles the main window; right-click
            // (or Ctrl-click on macOS) opens the menu with explicit Quit.
            let show_item = MenuItem::with_id(
                app, "tray_show", "Открыть А-ГОЛОС", true, None::<&str>,
            )?;
            let quit_item = MenuItem::with_id(
                app, "tray_quit", "Выход", true, None::<&str>,
            )?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let _tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(true) // monochrome on macOS menu bar
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "tray_show" => bring_main_to_front(app),
                    "tray_quit" => quit_app(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_recording,
            stop_recording,
            snapshot_recording,
            snapshot_recent,
            pull_pcm16_chunk,
            is_recording,
            paste,
            check_accessibility,
            configure_overlay,
            get_hotkey,
            set_hotkey,
            get_style,
            set_style,
            get_auth_token,
            get_auth_email,
            set_auth_session,
            clear_auth_session
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Minimize-to-tray: closing the main window's X just hides it.
            // The system tray icon stays so the user can bring it back.
            // Explicit "Выход" in the tray menu is the only way to fully exit.
            //
            // We prevent_close() to suppress Tauri's default destroy, then
            // hide() — the window's resources stay allocated for fast re-show.
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } = &event
            {
                if label == "main" {
                    api.prevent_close();
                    if let Some(w) = app_handle.get_webview_window("main") {
                        let _ = w.hide();
                    }
                    eprintln!("[lifecycle] main window hidden (still in tray)");
                }
            }
        });
}
