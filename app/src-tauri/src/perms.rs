//! macOS-specific permission + window-behaviour helpers.

#[cfg(target_os = "macos")]
pub fn prompt_accessibility() -> bool {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrustedWithOptions(
            options: core_foundation::dictionary::CFDictionaryRef,
        ) -> bool;
    }

    let key = CFString::from_static_string("AXTrustedCheckOptionPrompt");
    let value = CFBoolean::true_value();
    let dict = CFDictionary::from_CFType_pairs(&[(key, value)]);

    unsafe { AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef()) }
}

#[cfg(not(target_os = "macos"))]
pub fn prompt_accessibility() -> bool {
    true
}

/// Convert the overlay NSWindow into a Siri/Spotlight/Raycast-style floating
/// panel: always-on-top over any app including full-screen, doesn't steal
/// focus, doesn't activate our app, visible on every Space.
///
/// The recipe:
///   1. Swap class from NSWindow to NSPanel — enables panel semantics.
///   2. Add NSWindowStyleMaskNonactivatingPanel (1<<7) to styleMask — the
///      window won't pull focus / activate our app when it appears.
///   3. Collection behavior: CanJoinAllSpaces | Stationary | FullScreen-
///      Auxiliary | IgnoresCycle. With NSPanel, FullScreenAuxiliary does
///      the right thing (floats over current fullscreen Space, not bound
///      to a specific app).
///   4. Level = NSScreenSaverWindowLevel (1000) — above everything.
///   5. setHidesOnDeactivate:NO + setCanHide:NO — stays visible when our
///      app isn't frontmost.
///
/// Must be called on the main thread.
#[cfg(target_os = "macos")]
pub fn make_overlay_floating_over_fullscreen(ns_window: *mut std::ffi::c_void) {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};

    if ns_window.is_null() {
        eprintln!("[overlay] null ns_window ptr");
        return;
    }

    eprintln!("[overlay] configuring NSWindow at {ns_window:p}");

    unsafe {
        let window = ns_window as *mut AnyObject;
        let w = &*window;

        // 1. Swap class → NSPanel
        if let Some(panel_cls) = AnyClass::get(c"NSPanel") {
            extern "C" {
                fn object_setClass(
                    obj: *mut AnyObject,
                    cls: *const AnyClass,
                ) -> *const AnyClass;
            }
            let old_cls = object_setClass(window, panel_cls as *const _);
            eprintln!("[overlay] class-swapped NSWindow → NSPanel (prev: {old_cls:p})");
        } else {
            eprintln!("[overlay] WARN: NSPanel class not found");
        }

        // 2. Add non-activating panel style bit. Start from borderless only
        //    to keep things clean; Tauri's decorations(false) handles this.
        const NS_BORDERLESS: u64 = 0;
        const NS_NONACTIVATING_PANEL: u64 = 1 << 7;
        let style_mask: u64 = NS_BORDERLESS | NS_NONACTIVATING_PANEL;
        let _: () = msg_send![w, setStyleMask: style_mask];

        // 3. Collection behavior
        const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
        const STATIONARY: usize = 1 << 4;
        const IGNORES_CYCLE: usize = 1 << 6;
        const FULL_SCREEN_AUXILIARY: usize = 1 << 8;
        let behavior: usize = CAN_JOIN_ALL_SPACES
            | STATIONARY
            | IGNORES_CYCLE
            | FULL_SCREEN_AUXILIARY;
        let _: () = msg_send![w, setCollectionBehavior: behavior];

        // 4. Level
        const NS_SCREEN_SAVER_WINDOW_LEVEL: isize = 1000;
        let _: () = msg_send![w, setLevel: NS_SCREEN_SAVER_WINDOW_LEVEL];

        // 5. Don't hide when app deactivates.
        let _: () = msg_send![w, setHidesOnDeactivate: false];
        let _: () = msg_send![w, setCanHide: false];

        // Sanity check: read values back.
        let got_level: isize = msg_send![w, level];
        let got_behavior: usize = msg_send![w, collectionBehavior];
        let got_mask: u64 = msg_send![w, styleMask];
        eprintln!(
            "[overlay] applied: level={got_level} behavior={got_behavior:#x} styleMask={got_mask:#x}"
        );
    }
}

#[cfg(not(target_os = "macos"))]
pub fn make_overlay_floating_over_fullscreen(_ns_window: *mut std::ffi::c_void) {}
