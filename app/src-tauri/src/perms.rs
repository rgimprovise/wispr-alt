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

/// Configure an NSWindow so it sits above full-screen macOS apps and on all
/// Spaces. Tauri's `always_on_top` + `visible_on_all_workspaces` aren't
/// enough by themselves — we need to OR in `fullScreenAuxiliary` and bump
/// the window level past what a full-screen app uses.
///
/// NSWindowCollectionBehavior bit flags (from AppKit/NSWindow.h):
///   CanJoinAllSpaces      = 1 << 0   (= 1)
///   Stationary            = 1 << 4   (= 16)
///   FullScreenAuxiliary   = 1 << 8   (= 256)
///   IgnoresCycle          = 1 << 6   (= 64)
///
/// Window levels:
///   NSNormalWindowLevel       = 0
///   NSFloatingWindowLevel     = 3      (what always_on_top uses)
///   NSStatusWindowLevel       = 25
///   NSMainMenuWindowLevel     = 24
///   NSScreenSaverWindowLevel  = 1000   (above full-screen chrome)
#[cfg(target_os = "macos")]
pub fn make_overlay_floating_over_fullscreen(ns_window: *mut std::ffi::c_void) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    if ns_window.is_null() {
        return;
    }

    let window = ns_window as *mut AnyObject;
    const BEHAVIOR: usize = (1 << 0) | (1 << 4) | (1 << 8) | (1 << 6);
    const LEVEL: isize = 1000; // NSScreenSaverWindowLevel

    unsafe {
        let w = &*window;
        let _: () = msg_send![w, setCollectionBehavior: BEHAVIOR];
        let _: () = msg_send![w, setLevel: LEVEL];
    }
}

#[cfg(not(target_os = "macos"))]
pub fn make_overlay_floating_over_fullscreen(_ns_window: *mut std::ffi::c_void) {}
