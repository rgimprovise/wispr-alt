#!/usr/bin/env python3
from __future__ import annotations
"""
Extracts glyph outlines from RodchenkoC-SHA.otf and writes individual
SVG files for each glyph we need. Produces:

  brand/logo/svg/letter-a.svg                — single «А»
  brand/logo/svg/letter-g.svg / l.svg / o.svg / s.svg
  brand/logo/svg/wordmark-golos.svg          — white «ГОЛОС» horizontal
  brand/logo/svg/lockup-horizontal.svg       — red А + white ГОЛОС inline
  brand/logo/svg/lockup-vertical.svg         — red А stacked over ГОЛОС

Coordinate frame: SVG y-axis points down, glyph outlines from fontTools
have y-up. We flip via the outer transform on the root <svg>.
"""
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from pathlib import Path

FONT_PATH = "brand/fonts/RodchenkoC-SHA.otf"
OUT_DIR = Path("brand/logo/svg")
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Cyrillic capitals we need from the wordmark
CHARS = {
    "А": "letter-a",
    "Г": "letter-g",
    "О": "letter-o",
    "Л": "letter-l",
    "С": "letter-s",
}

font = TTFont(FONT_PATH)
cmap = font.getBestCmap()
gset = font.getGlyphSet()
units_per_em = font["head"].unitsPerEm
ascender = font["OS/2"].sTypoAscender
descender = font["OS/2"].sTypoDescender

def glyph_to_path_d(char: str) -> tuple[str, int, int, int, int]:
    """Returns (path_d, advance_width, x_min, y_min, x_max, y_max) for the
    given char. y is in glyph (y-up) coordinates."""
    code = ord(char)
    if code not in cmap:
        raise KeyError(f"glyph for U+{code:04X} ({char}) not in font")
    glyph_name = cmap[code]
    g = gset[glyph_name]
    pen = SVGPathPen(gset)
    g.draw(pen)
    bbox = g._glyph.calcBounds(gset) if hasattr(g, "_glyph") and hasattr(g._glyph, "calcBounds") else None
    # fallback bbox via pen-bounds
    from fontTools.pens.boundsPen import BoundsPen
    bp = BoundsPen(gset)
    g.draw(bp)
    if bp.bounds is None:
        x_min = y_min = x_max = y_max = 0
    else:
        x_min, y_min, x_max, y_max = bp.bounds
    return pen.getCommands(), g.width, int(x_min), int(y_min), int(x_max), int(y_max)


def write_svg(path: Path, viewbox: tuple, body: str, transform: str = ""):
    vb = " ".join(str(int(v)) for v in viewbox)
    if transform:
        inner = '<g transform="' + transform + '">' + body + '</g>'
    else:
        inner = '<g>' + body + '</g>'
    svg = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" '
        'fill="currentColor" fill-rule="nonzero">\n  ' + inner + '\n</svg>\n'
    )
    path.write_text(svg, encoding="utf-8")


def write_single_glyph(char: str, slug: str, color: str | None = None):
    d, adv, x0, y0, x1, y1 = glyph_to_path_d(char)
    # Flip y-axis (font is y-up, SVG is y-down). Padding 4% of em.
    pad = int(units_per_em * 0.04)
    height = y1 - y0
    width = x1 - x0
    vb_w = width + pad * 2
    vb_h = height + pad * 2
    # Move origin so glyph fits in viewBox: translate(-x0+pad, y1+pad), scale(1,-1)
    transform = f"translate({-x0 + pad},{y1 + pad}) scale(1,-1)"
    fill = f' fill="{color}"' if color else ""
    body = f'<path{fill} d="{d}"/>'
    write_svg(OUT_DIR / f"{slug}.svg", (0, 0, vb_w, vb_h), body, transform)
    return d, x0, y0, x1, y1, adv


def write_letter_a():
    """Just the «А», flat solid red (#F22A37). For small icons / status
    marks. The 3D origami treatment is only available as PNG."""
    write_single_glyph("А", "letter-a", color="#F22A37")


def write_wordmark_golos():
    """ГОЛОС horizontal, white (#F5F6F8). Used as wordmark next to the
    А mark and as standalone label."""
    chars = "ГОЛОС"
    cursor_x = 0
    pad = int(units_per_em * 0.04)
    parts = []
    overall_y_min = 0
    overall_y_max = 0
    for ch in chars:
        d, adv, x0, y0, x1, y1 = glyph_to_path_d(ch)
        # place glyph at cursor_x, no kerning for simplicity
        parts.append((d, cursor_x, x0, y0, x1, y1))
        cursor_x += adv
        overall_y_min = min(overall_y_min, y0)
        overall_y_max = max(overall_y_max, y1)
    width = cursor_x
    height = overall_y_max - overall_y_min
    vb_w = width + pad * 2
    vb_h = height + pad * 2
    body_paths = []
    for d, cx, x0, y0, x1, y1 in parts:
        body_paths.append(f'<path fill="#F5F6F8" d="{d}" transform="translate({cx},0)"/>')
    body = "\n    ".join(body_paths)
    transform = f"translate({pad},{overall_y_max + pad}) scale(1,-1)"
    write_svg(OUT_DIR / "wordmark-golos.svg", (0, 0, vb_w, vb_h), body, transform)
    return cursor_x, overall_y_max, overall_y_min


def write_lockup_horizontal(slug: str = "lockup-horizontal", a_color: str = "#F22A37", word_color: str = "#F5F6F8"):
    """А + ГОЛОС inline. Default: А red, ГОЛОС white. Override colors for
    monochrome variant (slug='lockup-mono-horizontal' both white)."""
    chars = "АГОЛОС"
    cursor_x = 0
    pad = int(units_per_em * 0.04)
    parts = []
    overall_y_min = 0
    overall_y_max = 0
    for i, ch in enumerate(chars):
        d, adv, x0, y0, x1, y1 = glyph_to_path_d(ch)
        # tiny gap after А
        gap = int(units_per_em * 0.06) if i == 0 else 0
        parts.append((ch, d, cursor_x + gap if i > 0 else cursor_x, x0, y0, x1, y1))
        cursor_x += adv + (gap if i > 0 else 0)
        overall_y_min = min(overall_y_min, y0)
        overall_y_max = max(overall_y_max, y1)
    width = cursor_x
    height = overall_y_max - overall_y_min
    vb_w = width + pad * 2
    vb_h = height + pad * 2
    body_paths = []
    for ch, d, cx, x0, y0, x1, y1 in parts:
        color = a_color if ch == "А" else word_color
        body_paths.append(f'<path fill="{color}" d="{d}" transform="translate({cx},0)"/>')
    body = "\n    ".join(body_paths)
    transform = f"translate({pad},{overall_y_max + pad}) scale(1,-1)"
    write_svg(OUT_DIR / f"{slug}.svg", (0, 0, vb_w, vb_h), body, transform)


def write_lockup_vertical():
    """А stacked over ГОЛОС. А scaled larger; ГОЛОС sized to match А width."""
    # А bigger, ГОЛОС fits roughly the width of А.
    a_d, a_adv, a_x0, a_y0, a_x1, a_y1 = glyph_to_path_d("А")
    a_w = a_x1 - a_x0
    a_h = a_y1 - a_y0

    # Build ГОЛОС as a horizontal sequence
    chars = "ГОЛОС"
    cursor = 0
    g_parts = []
    g_y_min = 0
    g_y_max = 0
    for ch in chars:
        d, adv, x0, y0, x1, y1 = glyph_to_path_d(ch)
        g_parts.append((d, cursor, x0, y0, x1, y1))
        cursor += adv
        g_y_min = min(g_y_min, y0)
        g_y_max = max(g_y_max, y1)
    g_w = cursor
    g_h = g_y_max - g_y_min

    # А scaled to be ~2.4× the height of ГОЛОС for visual balance.
    a_scale = (g_h * 2.4) / a_h
    a_scaled_w = a_w * a_scale
    a_scaled_h = a_h * a_scale

    pad = int(units_per_em * 0.04)
    gap_between = int(units_per_em * 0.20)

    # Total width = max(a_scaled_w, g_w); centre both.
    total_w = max(a_scaled_w, g_w) + pad * 2
    total_h = a_scaled_h + gap_between + g_h + pad * 2

    a_cx = (total_w - a_scaled_w) / 2
    g_cx = (total_w - g_w) / 2

    # In the destination canvas (y-down), А sits at top, ГОЛОС at bottom.
    a_path = (
        f'<g transform="translate({a_cx + (-a_x0 * a_scale)},{pad + a_scaled_h - (-a_y0 * a_scale) + (-a_y0 * a_scale)})">'
        f'<g transform="scale({a_scale},{-a_scale})">'
        f'<path fill="#F22A37" d="{a_d}"/></g></g>'
    )
    # Actually simpler: place А with one unified transform.
    a_block_y = pad + a_scaled_h
    a_path = (
        f'<g transform="translate({a_cx},{a_block_y}) scale({a_scale},{-a_scale})">'
        f'<path fill="#F22A37" d="{a_d}" transform="translate({-a_x0},{-a_y0})"/>'
        f'</g>'
    )

    g_block_y = pad + a_scaled_h + gap_between + g_h
    g_paths = []
    for d, cx, x0, y0, x1, y1 in g_parts:
        g_paths.append(f'<path fill="#F5F6F8" d="{d}" transform="translate({cx},0)"/>')
    g_block = "\n    ".join(g_paths)
    g_path = (
        f'<g transform="translate({g_cx},{g_block_y}) scale(1,-1)">'
        f"\n    {g_block}\n  "
        f"</g>"
    )

    body = a_path + "\n  " + g_path
    write_svg(OUT_DIR / "lockup-vertical.svg", (0, 0, total_w, total_h), body)


def main():
    for ch, slug in CHARS.items():
        color = "#F22A37" if ch == "А" else "#F5F6F8"
        write_single_glyph(ch, slug, color=color)
    write_wordmark_golos()
    write_lockup_horizontal()
    # Monochrome (white-only) lockup — for use on red bg or single-colour print.
    write_lockup_horizontal(
        slug="lockup-mono-horizontal",
        a_color="#F5F6F8",
        word_color="#F5F6F8",
    )
    write_lockup_vertical()
    for p in sorted(OUT_DIR.glob("*.svg")):
        print(f"  {p}  ({p.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
