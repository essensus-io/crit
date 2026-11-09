import { parseUnifiedDiff } from "@crit/core";
import type { FindingView, SessionState } from "./session.ts";
import { triage } from "./filter.ts";
import { clipToks, highlightLine } from "./highlight.ts";
import { SEV_COLOR, SEV_LABEL, T } from "./theme.ts";
import { wrapText } from "./widgets.tsx";

/** A piece of styled text. Rows are arrays of these, so their width is known. */
export type Seg = { t: string; color?: string; dim?: boolean; bold?: boolean; inverse?: boolean };
export type Line = Seg[];

export const lineLen = (l: Line) => l.reduce((n, s) => n + s.t.length, 0);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);

export const STATE_GLYPH = {
  pending: { glyph: "○", color: T.gray },
  accepted: { glyph: "✓", color: T.mint },
  dismissed: { glyph: "✗", color: T.yellow },
  applied: { glyph: "●", color: T.cyan },
} as const;

const SEVERITY_WORD = { critical: "CRIT", major: "MAJ", minor: "MIN", nit: "NIT" } as const;

export type CardOptions = {
  /** Total card width including its border. */
  width: number;
  focused: boolean;
  expanded: boolean;
  fixTab: "ai" | "user";
  /** A fix is being written: show this spinner frame in place of the fix line. */
  drafting?: string;
};

/** Wrap a whole line into rows no wider than `w`, keeping one style. */
function wrapped(text: string, w: number, style: Omit<Seg, "t"> = {}, indent = ""): Line[] {
  return wrapText(text, w - indent.length).map((l) => [{ t: indent + l, ...style }]);
}

/** The lines of a fix patch as colored rows (new-side line numbers). */
export function patchLines(patch: string, w: number): Line[] {
  const rows: { n: number; sign: string; text: string; path: string | undefined }[] = [];
  for (const file of parseUnifiedDiff(patch)) {
    for (const h of file.hunks) {
      let n = h.newStart;
      for (const l of h.body) {
        const sign = l[0] ?? " ";
        if (sign === "\\") continue;
        rows.push({
          n,
          sign,
          text: l.slice(1).replace(/\t/g, "  "),
          path: file.newPath ?? file.oldPath ?? undefined,
        });
        if (sign !== "-") n++;
      }
    }
  }
  const nw = Math.max(3, ...rows.map((r) => String(r.n).length));
  return rows.map((r) => {
    const mark = r.sign === "+" || r.sign === "-" ? r.sign : " ";
    const gutter = `${String(r.n).padStart(nw)} ${mark} `;
    const room = Math.max(8, w - gutter.length);
    const head: Seg =
      r.sign === "+"
        ? { t: gutter, color: T.mint }
        : r.sign === "-"
          ? { t: gutter, color: T.red }
          : { t: gutter, dim: true };
    // Removed lines stay red; added and context lines are syntax colored.
    const body: Seg[] =
      r.sign === "-"
        ? [{ t: clip(r.text, room), color: T.red }]
        : clipToks(highlightLine(r.path, r.text), room).map((k) => ({
            t: k.t,
            ...(k.color ? { color: k.color } : {}),
            ...(r.sign === " " ? { dim: true } : {}),
          }));
    return [head, ...body];
  });
}

/** Checkbox (agree with the fix) and title. */
function titleLine(item: FindingView, w: number): Line {
  const tri = triage(item);
  const box = tri === "accepted" ? "[x]" : tri === "pending" && item.fix ? "[ ]" : "   ";
  return [
    { t: `${box} `, color: tri === "accepted" ? T.mint : T.gray, bold: true },
    { t: clip(item.finding.title, w - 4), bold: true },
  ];
}

/** What the card says inside its border (without the border). */
export function cardBody(item: FindingView, state: SessionState, o: CardOptions): Line[] {
  const f = item.finding;
  const w = Math.max(16, o.width - 4);
  const out: Line[] = [];
  const fixSummary = item.fix?.summary;

  if (!o.expanded) {
    out.push(titleLine(item, w));
    const why = (f.failureScenario ?? f.explanation).replace(/\s+/g, " ").trim();
    out.push([{ t: "why ", dim: true }, { t: clip(why, w - 4) }]);
    out.push(
      o.drafting
        ? [{ t: `${o.drafting} writing a fix…`, color: T.orange }]
        : fixSummary
          ? [
              { t: item.fix?.author === "user" ? "your fix " : "fix ", dim: true },
              { t: clip(fixSummary, w - 9) },
            ]
          : [{ t: "no fix yet · i tells the AI what it should be", dim: true }],
    );
  } else {
    out.push(titleLine(item, w));
    out.push(...wrapped(f.explanation, w));
    if (f.failureScenario) {
      out.push([{ t: "Fails when", dim: true }]);
      out.push(...wrapped(f.failureScenario, w));
    }
    for (const id of f.ruleIds) {
      const r = state.rules.get(id);
      out.push([{ t: "Rule  ", dim: true }, { t: clip(`${id} ${r?.title ?? ""}`, w - 6) }]);
      if (r?.path)
        out.push([
          { t: clip(`      ${r.path}${r.section ? ` §${r.section}` : ""}`, w), dim: true },
        ]);
    }
    if (f.verdictReason)
      out.push([{ t: "Skeptic  ", dim: true }, { t: clip(f.verdictReason, w - 9) }]);
    out.push([{ t: `── fix ${"─".repeat(Math.max(0, w - 7))}`, color: T.lav }]);
    const both = Boolean(item.aiFix && item.userFix);
    const shown = both
      ? o.fixTab === "user"
        ? item.userFix
        : item.aiFix
      : (item.aiFix ?? item.userFix);
    out.push([
      ...(both
        ? [
            {
              t: ` AI ${item.fix?.id === item.aiFix?.id ? "●" : "○"} `,
              inverse: o.fixTab === "ai",
            },
            { t: " " },
            {
              t: ` yours ${item.fix?.id === item.userFix?.id ? "●" : "○"} `,
              inverse: o.fixTab === "user",
            },
            { t: "  tab switches", dim: true },
          ]
        : shown
          ? [{ t: shown.author === "user" ? "yours" : "the fix", bold: true }]
          : []),
      ...(shown?.evaluation
        ? [{ t: `  ${shown.evaluation}${shown.overridden ? " (used anyway)" : ""}`, dim: true }]
        : []),
      ...(shown?.verify
        ? [
            {
              t: `  verify ${shown.verify.passed ? "✓" : "✗"}`,
              color: shown.verify.passed ? T.mint : T.red,
            },
          ]
        : []),
    ]);
    if (shown) {
      out.push(...wrapped(shown.summary, w, { dim: true }));
      out.push(...patchLines(shown.patch, w));
    } else
      out.push([
        {
          t: o.drafting
            ? `${o.drafting} writing a fix…`
            : "No fix yet. Press i and tell the AI what it should be.",
          ...(o.drafting ? { color: T.orange } : { dim: true }),
        },
      ]);
    if (item.messages.length) {
      out.push([
        {
          t: `── thread (${item.messages.length}) ${"─".repeat(Math.max(0, w - 14))}`,
          color: T.lav,
        },
      ]);
      for (const m of item.messages) {
        const body = m.body.replace(/^\[(evaluation|override)\] /, "");
        wrapText(body, w - 4).forEach((l, i) =>
          out.push([
            i === 0
              ? {
                  t: m.role === "ai" ? "AI  " : "you ",
                  bold: true,
                  color: m.role === "ai" ? T.lav : T.cyan,
                }
              : { t: "    " },
            { t: l },
          ]),
        );
      }
    }
  }

  if (o.focused) {
    const state2 = triage(item);
    const keys: [string, string][] =
      state2 === "dismissed"
        ? [["d", "restore"]]
        : state2 === "applied"
          ? []
          : item.fix
            ? [
                ["space", state2 === "accepted" ? "uncheck" : "check to apply"],
                ["i", "change the fix"],
              ]
            : [["i", "tell the AI the fix"]];
    // Drop hints from the end until they fit the card.
    const size = (ks: [string, string][]) =>
      ks.reduce((n, [k, l], i) => n + (i ? 2 : 0) + k.length + l.length + 3, 0);
    while (keys.length > 1 && size(keys) > w) keys.pop();
    const hint = keys.flatMap(([k, label], i): Seg[] => [
      ...(i ? [{ t: "  ", dim: true }] : []),
      { t: `[${k}]`, bold: true, color: T.cyan },
      { t: ` ${label}`, dim: true },
    ]);
    // An expanded card can be taller than the screen: keep the keys at its top, in view.
    if (o.expanded) out.splice(1, 0, hint);
    else out.push(hint);
  }
  return out;
}

/** The card with its rounded border, one `Line` per terminal row. */
export function boxCard(item: FindingView, state: SessionState, o: CardOptions): Line[] {
  const f = item.finding;
  const tri = triage(item);
  const g = STATE_GLYPH[tri];
  const border = o.focused ? T.orange : tri === "dismissed" ? T.gray : T.lav;
  const w = o.width;
  const tag =
    f.verdict === "plausible" ? " · unsure" : item.fix?.author === "user" ? " · your fix" : "";
  const head: Line = [
    { t: "╭─ ", color: border },
    { t: g.glyph, color: g.color, bold: true },
    { t: " " },
    { t: SEVERITY_WORD[f.severity], color: SEV_COLOR[f.severity], bold: true },
    { t: ` · ${f.category}${tag} `, dim: true },
  ];
  const used = lineLen(head);
  head.push({ t: "─".repeat(Math.max(0, w - used - 1)), color: border }, { t: "╮", color: border });
  const rows: Line[] = [head];
  for (const l of cardBody(item, state, o)) {
    const pad = Math.max(0, w - 4 - lineLen(l));
    rows.push([{ t: "│ ", color: border }, ...l, { t: `${" ".repeat(pad)} │`, color: border }]);
  }
  rows.push([{ t: `╰${"─".repeat(Math.max(0, w - 2))}╯`, color: border }]);
  void SEV_LABEL;
  return rows;
}
