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

/** What the card says inside its border (without the border). */
export function cardBody(item: FindingView, state: SessionState, o: CardOptions): Line[] {
  const f = item.finding;
  const w = Math.max(16, o.width - 4);
  const out: Line[] = [];
  const fixSummary = item.fix?.summary;

  if (!o.expanded) {
    out.push([{ t: clip(f.title, w), bold: true }]);
    const why = (f.failureScenario ?? f.explanation).replace(/\s+/g, " ").trim();
    out.push([{ t: "why ", dim: true }, { t: clip(why, w - 4) }]);
    out.push(
      fixSummary
        ? [
            { t: item.fix?.author === "user" ? "your fix " : "fix ", dim: true },
            { t: clip(fixSummary, w - 9) },
          ]
        : [{ t: "no fix yet · a proposes one", dim: true }],
    );
  } else {
    out.push([{ t: clip(f.title, w), bold: true }]);
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
    const shown = o.fixTab === "user" ? item.userFix : item.aiFix;
    out.push([
      {
        t: ` AI ${item.aiFix ? (item.fix?.id === item.aiFix.id ? "●" : "○") : "–"} `,
        inverse: o.fixTab === "ai",
      },
      { t: " " },
      {
        t: ` yours ${item.userFix ? (item.fix?.id === item.userFix.id ? "●" : "○") : "–"} `,
        inverse: o.fixTab === "user",
      },
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
      { t: item.userFix || o.fixTab === "user" ? "  tab switches" : "", dim: true },
    ]);
    if (shown) {
      out.push(...wrapped(shown.summary, w, { dim: true }));
      out.push(...patchLines(shown.patch, w));
    } else
      out.push([
        {
          t:
            o.fixTab === "user"
              ? "No fix of yours yet. Press . then p to propose one."
              : "The reviewer proposed no fix.",
          dim: true,
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
          ? [["enter", o.expanded ? "less" : "details"]]
          : [
              [
                "a",
                item.fix ? (state2 === "accepted" ? "undo accept" : "accept fix") : "propose a fix",
              ],
              ["d", "dismiss"],
              ["enter", o.expanded ? "less" : "details"],
            ];
    out.push(
      keys.flatMap(([k, label], i): Seg[] => [
        ...(i ? [{ t: "  ", dim: true }] : []),
        { t: `[${k}]`, bold: true, color: T.cyan },
        { t: ` ${label}`, dim: true },
      ]),
    );
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
