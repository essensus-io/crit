import type { LineRange } from "@crit/schema";
import { normalizeCode } from "./fingerprint.ts";

export type AnchorMatch = { range: LineRange; exact: boolean };

/**
 * Find `anchor` (an exact code excerpt, possibly several lines) in `content`.
 * Prefers the occurrence nearest `near`. Falls back to a whitespace-insensitive
 * line match. Returns the 1-based line range of the match.
 */
export function locateAnchor(
  content: string,
  anchor: string,
  near?: LineRange,
): AnchorMatch | undefined {
  const lines = content.split("\n");
  const anchorLines = anchor
    .replace(/\r\n/g, "\n")
    .replace(/^\n+|\n+$/g, "")
    .split("\n");
  const span = anchorLines.length;
  const target = near ? (near.start + near.end) / 2 : 0;
  const candidates: AnchorMatch[] = [];

  // Exact substring match within a window of `span` lines.
  if (anchor.trim()) {
    const first = anchorLines[0]!.trim();
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.includes(first)) continue;
      const window = lines.slice(i, i + span).join("\n");
      if (window.includes(anchorLines.join("\n").trim())) {
        candidates.push({ range: { start: i + 1, end: i + span }, exact: true });
      }
    }
  }
  // Whitespace-insensitive fallback: grow a window from each line until it
  // holds the anchor (an anchor written on one line may span several).
  if (candidates.length === 0) {
    const want = normalizeCode(anchor);
    if (!want) return undefined;
    for (let i = 0; i < lines.length; i++) {
      if (!normalizeCode(lines[i]!)) continue;
      let window = "";
      for (let j = i; j < Math.min(lines.length, i + span + 20); j++) {
        window = normalizeCode(`${window} ${lines[j]}`);
        if (window.includes(want)) {
          // Only keep windows that start where the anchor starts.
          if (!normalizeCode(lines.slice(i + 1, j + 1).join(" ")).includes(want)) {
            candidates.push({ range: { start: i + 1, end: j + 1 }, exact: false });
          }
          break;
        }
        if (window.length > want.length * 2 + 200) break;
      }
    }
  }
  if (candidates.length === 0) return undefined;
  return candidates.reduce((best, c) =>
    Math.abs(c.range.start - target) < Math.abs(best.range.start - target) ? c : best,
  );
}

/**
 * Move a finding's range to where its anchor is now. Returns undefined when
 * the anchor is gone (the code the finding pointed to was removed).
 */
export function reanchor(content: string, anchor: string, range: LineRange): LineRange | undefined {
  const m = locateAnchor(content, anchor, range);
  if (!m) return undefined;
  // Keep the original range length if it extended past the anchor itself.
  const len = range.end - range.start;
  const delta = m.range.start - range.start;
  return { start: range.start + delta, end: Math.max(m.range.end, range.start + delta + len) };
}

/** 1-based line count, not counting a trailing newline. */
export const lineCount = (content: string) => {
  if (content === "") return 0;
  const n = content.split("\n").length;
  return content.endsWith("\n") ? n - 1 : n;
};

/** Lines [start-context, end+context] of content with line numbers, for prompts. */
export function excerpt(content: string, range: LineRange, context = 6): string {
  const lines = content.split("\n");
  const from = Math.max(1, range.start - context);
  const to = Math.min(lineCount(content), range.end + context);
  const width = String(to).length;
  const out: string[] = [];
  for (let n = from; n <= to; n++) {
    const mark = n >= range.start && n <= range.end ? ">" : " ";
    out.push(`${mark}${String(n).padStart(width)}  ${lines[n - 1]}`);
  }
  return out.join("\n");
}
