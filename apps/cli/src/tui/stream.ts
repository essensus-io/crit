import { boxCard, type Line } from "./card.ts";
import type { CodeInfo, FindingView, SessionState } from "./session.ts";
import { T } from "./theme.ts";

export type StreamRow = {
  kind: "file" | "code" | "gap" | "card";
  line: Line;
  /** The finding a card (or its highlighted code) belongs to. */
  findingId?: string;
};

export type Stream = {
  rows: StreamRow[];
  /** First row of each finding's card, and its last row. */
  card: Map<string, { from: number; to: number }>;
};

const CONTEXT = 3;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);

export type StreamInput = {
  items: FindingView[];
  state: SessionState;
  code: Map<string, CodeInfo>;
  current: string | undefined;
  expanded: ReadonlySet<string>;
  fixTab: "ai" | "user";
  width: number;
};

/**
 * Everything the stream shows, as rows: for each file with findings, the code
 * around each finding (changed lines marked), long unchanged stretches folded,
 * and each finding as a card right under the lines it is about.
 */
export function buildStream(input: StreamInput): Stream {
  const { items, state, code, current, expanded, fixTab, width } = input;
  const rows: StreamRow[] = [];
  const card = new Map<string, { from: number; to: number }>();
  const cardWidth = Math.max(24, width - 2);

  const pushCard = (item: FindingView) => {
    const id = item.finding.id;
    const lines = boxCard(item, state, {
      width: cardWidth,
      focused: id === current,
      expanded: expanded.has(id),
      fixTab,
    });
    const from = rows.length;
    for (const line of lines)
      rows.push({ kind: "card", line: [{ t: " " }, ...line], findingId: id });
    card.set(id, { from, to: rows.length - 1 });
  };

  const byFile = new Map<string, FindingView[]>();
  for (const it of items) byFile.set(it.finding.file, [...(byFile.get(it.finding.file) ?? []), it]);

  for (const [file, list] of byFile) {
    rows.push({
      kind: "file",
      line: [
        { t: " ▍ ", color: T.cyan },
        { t: file, bold: true },
        { t: `  ${list.length} finding${list.length === 1 ? "" : "s"}`, dim: true },
      ],
    });
    const info = code.get(file);
    if (!info) {
      for (const it of list) pushCard(it);
      rows.push({ kind: "gap", line: [{ t: " " }] });
      continue;
    }
    const total = info.lines.length;
    const range = (it: FindingView) => ({
      start: Math.min(total, Math.max(1, it.finding.range.start)),
      end: Math.min(total, Math.max(1, it.finding.range.end)),
    });
    // Windows of code around the findings; windows that touch merge into one.
    const windows: { s: number; e: number }[] = [];
    for (const it of list) {
      const r = range(it);
      const w = { s: Math.max(1, r.start - CONTEXT), e: Math.min(total, r.end + CONTEXT) };
      const last = windows.at(-1);
      if (last && w.s <= last.e + 2) last.e = Math.max(last.e, w.e);
      else windows.push(w);
    }
    const focusedRange = (() => {
      const c = list.find((i) => i.finding.id === current);
      return c ? range(c) : undefined;
    })();
    const nw = String(total).length;
    let prevEnd = 0;
    const gap = (from: number, to: number) => {
      if (to < from) return;
      const n = to - from + 1;
      rows.push({
        kind: "gap",
        line: [{ t: ` ${" ".repeat(nw)}  ⋯ ${n} unchanged line${n === 1 ? "" : "s"}`, dim: true }],
      });
    };
    for (const w of windows) {
      gap(prevEnd + 1, w.s - 1);
      for (let n = w.s; n <= w.e; n++) {
        const inFocus = focusedRange && n >= focusedRange.start && n <= focusedRange.end;
        const added = info.added.has(n);
        const text = clip(
          (info.lines[n - 1] ?? "").replace(/\t/g, "  "),
          Math.max(10, width - nw - 8),
        );
        rows.push({
          kind: "code",
          line: [
            { t: ` ${String(n).padStart(nw)} `, dim: true },
            inFocus ? { t: "▎", color: T.orange } : { t: " " },
            added ? { t: "+ ", color: T.mint } : { t: "  " },
            added || inFocus ? { t: text } : { t: text, dim: true },
          ],
        });
        for (const it of list) if (range(it).end === n) pushCard(it);
      }
      prevEnd = w.e;
    }
    gap(prevEnd + 1, total);
    rows.push({ kind: "gap", line: [{ t: " " }] });
  }
  return { rows, card };
}
