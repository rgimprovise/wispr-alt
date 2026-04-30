import UIKit

/// Renders the Belovik «Б» mark to a UIImage at any size and tint.
/// Avoids shipping a PDF/PNG asset — paths come from logo-b-mono.svg
/// (viewBox 220×230) translated into UIBezierPath commands.
enum BelovikMark {
    /// Draws a square UIImage with the Б mark filled in `color`. Use as a
    /// button image; alpha can be set on the parent view.
    static func image(size: CGSize, color: UIColor) -> UIImage {
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { ctx in
            let cg = ctx.cgContext
            // Scale the 220×230 viewBox into our requested size, with letter-
            // boxing so the proportion stays.
            let viewW: CGFloat = 220
            let viewH: CGFloat = 230
            let scale = min(size.width / viewW, size.height / viewH)
            let dx = (size.width  - viewW * scale) / 2
            let dy = (size.height - viewH * scale) / 2
            cg.translateBy(x: dx, y: dy)
            cg.scaleBy(x: scale, y: scale)

            color.setFill()
            for path in paths { path.fill() }
        }
    }

    private static let paths: [UIBezierPath] = [
        path("M 30 38 C 48 26, 78 22, 112 28 C 128 31, 140 34, 152 36 C 138 40, 116 42, 96 42 C 76 42, 56 44, 32 50 C 28 50, 26 47, 28 43 Z"),
        path("M 76 30 C 84 28, 92 30, 94 38 C 94 60, 88 80, 80 100 C 76 110, 72 122, 70 138 C 68 158, 70 178, 76 196 C 78 202, 76 206, 70 206 C 60 206, 52 200, 50 188 C 48 168, 52 148, 58 128 C 64 108, 70 88, 72 66 C 72 54, 72 44, 70 36 C 70 32, 72 30, 76 30 Z"),
        path("M 78 38 C 102 32, 134 32, 158 38 C 168 41, 168 50, 158 52 C 136 56, 110 56, 84 52 C 76 50, 74 42, 78 38 Z"),
        path("M 76 96 C 96 86, 130 84, 152 96 C 178 110, 184 148, 168 174 C 150 200, 110 206, 84 192 C 70 184, 64 172, 64 160 C 66 158, 70 158, 72 160 C 78 174, 96 184, 116 184 C 142 184, 162 168, 162 144 C 162 122, 144 106, 120 104 C 104 102, 90 106, 80 112 C 76 114, 72 112, 74 106 C 74 102, 74 98, 76 96 Z"),
    ]

    /// Tiny SVG-path subset parser: handles M, C, Z (uppercase, absolute).
    /// Sufficient for the four Б paths above.
    private static func path(_ d: String) -> UIBezierPath {
        let p = UIBezierPath()
        let scanner = Scanner(string: d)
        scanner.charactersToBeSkipped = CharacterSet(charactersIn: " ,\n\t")
        var current = CGPoint.zero

        while !scanner.isAtEnd {
            guard let cmd = scanner.scanCharacter() else { break }
            switch cmd {
            case "M":
                let pt = scanPoint(scanner) ?? .zero
                p.move(to: pt)
                current = pt
            case "C":
                // Cubic Bezier: three control point pairs.
                while let c1 = scanPoint(scanner),
                      let c2 = scanPoint(scanner),
                      let end = scanPoint(scanner) {
                    p.addCurve(to: end, controlPoint1: c1, controlPoint2: c2)
                    current = end
                    // Stop if next char is a command, not a digit/sign
                    if let peek = peekNonSpace(scanner), peek.isLetter { break }
                }
            case "Z", "z":
                p.close()
            default:
                continue
            }
        }
        return p
    }

    private static func scanPoint(_ s: Scanner) -> CGPoint? {
        guard let x = s.scanDouble() else { return nil }
        guard let y = s.scanDouble() else { return nil }
        return CGPoint(x: x, y: y)
    }

    private static func peekNonSpace(_ s: Scanner) -> Character? {
        let str = s.string as NSString
        var idx = s.scanLocation
        while idx < str.length {
            let ch = str.character(at: idx)
            if ch != 0x20 && ch != 0x09 && ch != 0x0A && ch != 0x2C { // space, tab, lf, comma
                return Character(UnicodeScalar(ch)!)
            }
            idx += 1
        }
        return nil
    }
}
