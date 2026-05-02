/**
 * Convert the cleanup model's markdown output into plain text suitable
 * for pasting into Telegram, notes apps, email clients — places where
 * raw `#` / `**` / `- ` would look like garbage.
 *
 * The cleanup prompt restricts the model to a small markdown subset:
 * paragraphs separated by `\n\n`, `# ` / `## ` headings, `- ` and `N. `
 * lists. Anything else (bold, italics, blockquotes, code, links) is
 * disallowed by the prompt but stripped here too as a safety net.
 *
 * Conventions chosen here:
 *   - Headings collapse to a plain line (no trailing colon, no caps),
 *     followed by a blank line. The visual hierarchy comes from the
 *     blank line above + below, like a paragraph break with intent.
 *   - Bullet lists use the Russian em-dash «— » per BRAND.md voice.
 *   - Numbered lists are left as-is («1. ») since that reads naturally
 *     in plain text everywhere.
 */
export function markdownToPlain(md: string): string {
  if (!md) return md;

  const lines = md.split("\n");
  const out: string[] = [];

  for (const rawLine of lines) {
    let line = rawLine;

    // # Heading / ## Subheading / ### etc — drop the markers.
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (heading) {
      out.push(heading[1].trimEnd());
      continue;
    }

    // Blockquote `> text` — drop the marker, keep the text.
    line = line.replace(/^\s*>\s?/, "");

    // Bullet list `- item` or `* item` → «— item». Keep leading indent.
    line = line.replace(/^(\s*)[-*]\s+(.*)$/, "$1— $2");

    // Numbered list `1. item` left as-is — already readable.

    // Inline emphasis: **bold**, __bold__, *italic*, _italic_ — drop markers.
    line = stripInlineEmphasis(line);

    // Inline code `code` — drop backticks.
    line = line.replace(/`([^`]+)`/g, "$1");

    // Links [text](url) → text
    line = line.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

    out.push(line);
  }

  // Collapse 3+ blank lines (model overshoot) to a single blank line.
  let joined = out.join("\n").replace(/\n{3,}/g, "\n\n");

  // Trim leading/trailing whitespace + blank lines.
  joined = joined.replace(/^\s+/, "").replace(/\s+$/, "");

  return joined;
}

/**
 * Strip **bold**, __bold__, *italic*, _italic_ markers without touching
 * single dashes/underscores inside words. We intentionally do NOT try to
 * match across newlines.
 */
function stripInlineEmphasis(line: string): string {
  // Order matters: handle the doubled markers first so a `**word**`
  // doesn't get partially eaten by the single-marker rule.
  let out = line;
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  out = out.replace(/__([^_\n]+)__/g, "$1");
  // Single * — only when it surrounds non-space text and isn't a bullet.
  out = out.replace(/(?<![*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g, "$1");
  // Single _ — same care, and avoid breaking snake_case identifiers.
  out = out.replace(/(?<![_\w])_(?!\s)([^_\n]+?)(?<!\s)_(?![_\w])/g, "$1");
  return out;
}
