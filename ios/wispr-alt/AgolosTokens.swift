import SwiftUI

/// А-ГОЛОС design tokens — single source of truth for iOS.
/// Mirrors `app/src/tokens.css` and `android/.../colors.xml` so all
/// three platforms render the same brand. See brand/BRAND.md.
///
/// v2 is dark-only. The `AgolosColor` enum name is kept for
/// backward-compatibility with existing UI code; values are remapped
/// to the new dark А-ГОЛОС palette. New brand-named aliases (signalRed,
/// charcoal, etc.) are additive — prefer those in new code.
enum AgolosColor {
    // ── New A-GOLOS brand palette ──────────────────────────
    static let charcoal     = Color(hex: 0x0B0D16)  // base
    static let nightBlue    = Color(hex: 0x11182B)
    static let burgundy     = Color(hex: 0x3A0D14)
    static let signalRed    = Color(hex: 0xF22A37)  // accent
    static let signalRedDeep = Color(hex: 0xB90F1C)
    static let softWhite    = Color(hex: 0xF5F6F8)
    static let uiGrey       = Color(hex: 0x8A90A2)

    // ── Legacy aliases (existing UI code keeps using these) ─
    // Bound to dark equivalents so SwiftUI views that read
    // AgolosColor.paper, .graphite etc. render the new theme
    // without source changes.
    static let paper        = Color(hex: 0x0B0D16)
    static let paperSoft    = Color(hex: 0x161A24)
    static let paperPure    = Color(hex: 0x161A24)
    static let mint         = Color(hex: 0x1A1F2D)
    static let silver       = Color(hex: 0x2A3340)

    static let ink          = Color(hex: 0xF5F6F8)
    static let graphite     = Color(hex: 0xF22A37)  // was graphite — now red CTA
    static let graphiteSoft = Color(hex: 0xB90F1C)

    static let textPrimary   = Color(hex: 0xF5F6F8)
    static let textSecondary = Color(hex: 0x8A90A2)
    static let textTertiary  = Color(hex: 0x5C616E)
    static let textInverse   = Color(hex: 0x0B0D16)

    static let surface       = Color(hex: 0x161A24)
    static let surfaceSunk   = Color(hex: 0x0B0D16)
    static let surfaceMint   = Color(hex: 0x1A1F2D)
    static let surface2      = Color(hex: 0x1C2030)

    // ── Semantic states — recording is RED in v2 ──────────
    static let rec           = Color(hex: 0xF22A37)
    static let transcribing  = Color(hex: 0x6E7AAB)
    static let success       = Color(hex: 0x7AB37D)
    static let error         = Color(hex: 0xF22A37)
    static let warn          = Color(hex: 0xD8A86A)

    static let borderSubtle  = Color.white.opacity(0.10)
    static let borderStrong  = Color.white.opacity(0.18)
    static let borderAccent  = Color(hex: 0xF22A37, opacity: 0.40)
}

enum AgolosRadius {
    static let sm: CGFloat = 8
    static let md: CGFloat = 14   // buttons / inputs (was 12)
    static let lg: CGFloat = 16
    static let xl: CGFloat = 20
    static let xxl: CGFloat = 24  // cards / panels
    static let xxxl: CGFloat = 32
    static let xxxxl: CGFloat = 40
}

extension Font {
    /// Display headings — Inter Display (registered in Info.plist /
    /// added to bundle in B1). Falls back to system rounded-bold while
    /// the font file is being added so the build doesn't break.
    static func agolosDisplay(_ size: CGFloat, weight: Font.Weight = .black) -> Font {
        if let _ = UIFont(name: "InterDisplay-Black", size: size) {
            return .custom("InterDisplay-Black", size: size)
        }
        return .system(size: size, weight: weight, design: .default)
    }

    /// UI / body — Inter (added to bundle in B1).
    static func agolosUI(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        let postscript: String
        switch weight {
        case .bold:     postscript = "Inter-Bold"
        case .semibold: postscript = "Inter-SemiBold"
        case .medium:   postscript = "Inter-Medium"
        default:        postscript = "Inter-Regular"
        }
        if let _ = UIFont(name: postscript, size: size) {
            return .custom(postscript, size: size)
        }
        return .system(size: size, weight: weight, design: .default)
    }

    static func agolosMono(_ size: CGFloat) -> Font {
        .system(size: size, weight: .medium, design: .monospaced)
    }
}

// MARK: - Hex helper

extension Color {
    init(hex: UInt32, opacity: Double = 1.0) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8) & 0xFF) / 255.0
        let b = Double(hex & 0xFF) / 255.0
        self.init(.sRGB, red: r, green: g, blue: b, opacity: opacity)
    }
}
