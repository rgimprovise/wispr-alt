import SwiftUI

/// Belovik design tokens — single source of truth for iOS.
/// Mirrors `app/src/tokens.css` (HTML) and `android/.../colors.xml` (Android)
/// so all three platforms render the same brand.
///
/// Light-first; dark variant via @Environment(\.colorScheme).
enum BelovikColor {
    static let paper        = Color(hex: 0xF4F1EC)  // bumagа
    static let paperSoft    = Color(hex: 0xF8F6F1)
    static let paperPure    = Color(hex: 0xFCFAF6)
    static let mint         = Color(hex: 0xECEFEA)
    static let silver       = Color(hex: 0xD8D6D0)

    static let ink          = Color(hex: 0x15171A)  // primary text
    static let graphite     = Color(hex: 0x1F2733)  // active accent
    static let graphiteSoft = Color(hex: 0x2A3340)

    static let textPrimary   = Color(hex: 0x15171A)
    static let textSecondary = Color(hex: 0x555A63)
    static let textTertiary  = Color(hex: 0x8A8E96)
    static let textInverse   = Color(hex: 0xFCFAF6)

    static let surface       = Color(hex: 0xFCFAF6)
    static let surfaceSunk   = Color(hex: 0xE8E5DD)
    static let surfaceMint   = Color(hex: 0xECEFEA)

    // Semantic — graphite REC, NOT red (per brandbook).
    static let rec           = Color(hex: 0x1F2733)
    static let transcribing  = Color(hex: 0x6B7A8F)
    static let success       = Color(hex: 0x5C7A5A)
    static let error         = Color(hex: 0x8E3A3A)
    static let warn          = Color(hex: 0xB5803A)

    static let borderSubtle  = Color.black.opacity(0.09)
    static let borderStrong  = Color.black.opacity(0.16)
}

enum BelovikRadius {
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 20
    static let xxl: CGFloat = 24
    static let xxxl: CGFloat = 32
    static let xxxxl: CGFloat = 40
}

extension Font {
    /// Belovik display — uses system serif (close to Fraunces feel) for headings.
    static func belovikDisplay(_ size: CGFloat) -> Font {
        .system(size: size, weight: .medium, design: .serif)
    }

    /// Belovik UI — Manrope-like via system sans.
    static func belovikUI(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .default)
    }

    static func belovikMono(_ size: CGFloat) -> Font {
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
