import UIKit

/// Renders the А-ГОЛОС angular «А» mark to a UIImage at any size and tint.
/// Path extracted from RodchenkoC SHA glyph for «А» — exact match to
/// brand/logo/svg/letter-a.svg.
///
/// Type name kept as `AgolosMark` for backward compat with existing
/// keyboard call sites; will be renamed in a follow-up B2 pass alongside
/// bundle id / URL scheme migration.
enum AgolosMark {
    /// Draws a square UIImage with the «А» mark filled in `color`.
    static func image(size: CGSize, color: UIColor) -> UIImage {
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { ctx in
            let cg = ctx.cgContext
            // Glyph SVG viewBox — same as brand/logo/svg/letter-a.svg.
            let viewW: CGFloat = 746
            let viewH: CGFloat = 842
            let scale = min(size.width / viewW, size.height / viewH)
            let dx = (size.width  - viewW * scale) / 2
            let dy = (size.height - viewH * scale) / 2
            cg.translateBy(x: dx, y: dy)
            cg.scaleBy(x: scale, y: scale)
            // Font coordinates are y-up; the SVG bakes a translate(40,802)
            // scale(1,-1) to flip into y-down viewBox space. Mirror that
            // transform here so the raw font path data renders correctly.
            cg.translateBy(x: 40, y: 802)
            cg.scaleBy(x: 1, y: -1)

            color.setFill()
            letterAPath.fill()
        }
    }

    /// «А» glyph in font coordinates (y-up). Equivalent SVG path data:
    ///   M340 238 H256 L322 0 H0 L160 611 L238 305 H322 L203 762 H465 L666 0 H404 L340 238 Z
    private static let letterAPath: UIBezierPath = {
        let p = UIBezierPath()
        p.move   (to: CGPoint(x: 340, y: 238))
        p.addLine(to: CGPoint(x: 256, y: 238))   // H256
        p.addLine(to: CGPoint(x: 322, y:   0))   // L322 0
        p.addLine(to: CGPoint(x:   0, y:   0))   // H0
        p.addLine(to: CGPoint(x: 160, y: 611))   // L160 611
        p.addLine(to: CGPoint(x: 238, y: 305))   // L238 305
        p.addLine(to: CGPoint(x: 322, y: 305))   // H322
        p.addLine(to: CGPoint(x: 203, y: 762))   // L203 762
        p.addLine(to: CGPoint(x: 465, y: 762))   // H465
        p.addLine(to: CGPoint(x: 666, y:   0))   // L666 0
        p.addLine(to: CGPoint(x: 404, y:   0))   // H404
        p.addLine(to: CGPoint(x: 340, y: 238))   // L340 238
        p.close()
        return p
    }()
}
