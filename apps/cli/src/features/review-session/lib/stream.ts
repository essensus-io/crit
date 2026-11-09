import { boxCard, type Line } from "./finding-card.ts";
import { clipToks, highlightFile } from "@/shared/lib/highlight.ts";
import type {
  CodeInfo,
  FindingView,
  SessionState,
} from "@/features/review-session/model/session.ts";
import { T } from "@/shared/lib/theme.ts";

export type StreamRow = {
  kind: "file" | "code" | "gap" | "card";
  line: Line;
  findingId?: string;
};

export type Stream = {
  rows: StreamRow[];
  card: Map<string, { from: number; to: number }>;
};

const CONTEXT = 3;

export type StreamInput = {
  items: FindingView[];
  state: SessionState;
  code: Map<string, CodeInfo>;
  current: string | undefined;
  expanded: ReadonlySet<string>;
  fixTab: "ai" | "user";
  width: number;
  drafting?: ReadonlySet<string>;
  spin?: string;
};

export function buildStream(input: StreamInput): Stream {
  const { items, state, code, current, expanded, fixTab, width, drafting, spin } = input;
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
      ...(drafting?.has(id) ? { drafting: spin ?? "…" } : {}),
    });
    const from = rows.length;
    for (const line of lines)
      rows.push({ kind: "card", line: [{ t: " " }, ...line], findingId: id });
    card.set(id, { from, to: rows.length - 1 });
  };

  const byFile = new Map<string, FindingView[]>();
  for (const findingView of items)
    byFile.set(findingView.finding.file, [
      ...(byFile.get(findingView.finding.file) ?? []),
      findingView,
    ]);

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
      for (const findingView of list) pushCard(findingView);
      rows.push({ kind: "gap", line: [{ t: " " }] });
      continue;
    }
    const total = info.lines.length;
    const range = (findingView: FindingView) => ({
      start: Math.min(total, Math.max(1, findingView.finding.range.start)),
      end: Math.min(total, Math.max(1, findingView.finding.range.end)),
    });
    const windows: { s: number; e: number }[] = [];
    for (const findingView of list) {
      const result = range(findingView);
      const w = {
        s: Math.max(1, result.start - CONTEXT),
        e: Math.min(total, result.end + CONTEXT),
      };
      const last = windows.at(-1);
      if (last && w.s <= last.e + 2) last.e = Math.max(last.e, w.e);
      else windows.push(w);
    }
    const focusedRange = (() => {
      const c = list.find((i) => i.finding.id === current);
      return c ? range(c) : undefined;
    })();
    const nw = String(total).length;
    if (info.tokens === undefined) info.tokens = highlightFile(file, info.lines);
    const tokens = info.tokens ?? undefined;
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
        const toks = clipToks(
          tokens?.[n - 1] ?? [{ t: (info.lines[n - 1] ?? "").replace(/\t/g, "  ") }],
          Math.max(10, width - nw - 8),
        );
        rows.push({
          kind: "code",
          line: [
            { t: ` ${String(n).padStart(nw)} `, dim: true },
            inFocus ? { t: "▎", color: T.orange } : { t: " " },
            added ? { t: "+ ", color: T.mint } : { t: "  " },
            ...toks.map((tok) => ({
              t: tok.t,
              ...(tok.color ? { color: tok.color } : {}),
              ...(added || inFocus ? {} : { dim: true }),
            })),
          ],
        });
        for (const findingView of list) if (range(findingView).end === n) pushCard(findingView);
      }
      prevEnd = w.e;
    }
    gap(prevEnd + 1, total);
    rows.push({ kind: "gap", line: [{ t: " " }] });
  }
  return { rows, card };
}
