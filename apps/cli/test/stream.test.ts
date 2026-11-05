import type { Finding } from "@crit/schema";
import { describe, expect, it } from "vitest";
import { lineLen, type Line } from "../src/tui/card.ts";
import { parseQuery, triage, visibleItems } from "../src/tui/filter.ts";
import type { CodeInfo, FindingView, SessionState } from "../src/tui/session.ts";
import { buildStream, type StreamInput } from "../src/tui/stream.ts";

const text = (l: Line) => l.map((s) => s.t).join("");

function view(id: string, start: number, end = start, over: Partial<Finding> = {}): FindingView {
  return {
    finding: {
      id,
      reviewId: "r",
      fingerprint: id,
      file: "a.ts",
      range: { start, end },
      anchor: "x",
      severity: "major",
      category: "correctness",
      title: `Title ${id}`,
      explanation: `Explanation ${id}`,
      confidence: 0.9,
      ruleIds: [],
      status: "open",
      selected: false,
      ...over,
    } as Finding,
    messages: [],
  };
}

const code = (n: number, added: number[] = []): CodeInfo => ({
  lines: Array.from({ length: n }, (_, i) => `line ${i + 1}`),
  added: new Set(added),
});
const state = { rules: new Map() } as unknown as SessionState;
const build = (items: FindingView[], c: Map<string, CodeInfo>, over: Partial<StreamInput> = {}) =>
  buildStream({
    items,
    state,
    code: c,
    current: items[0]?.finding.id,
    expanded: new Set(),
    fixTab: "ai",
    width: 80,
    ...over,
  });
const gaps = (rows: { kind: string; line: Line }[]) =>
  rows
    .filter((r) => r.kind === "gap" && text(r.line).includes("⋯"))
    .map((r) => text(r.line).trim());

describe("buildStream", () => {
  it("shows a window of code around a finding with the card right under its last line", () => {
    const s = build([view("f1", 20, 21)], new Map([["a.ts", code(100, [20])]]));
    const rows = s.rows.map((r) => text(r.line));
    expect(rows[0]).toContain("a.ts");
    expect(gaps(s.rows)).toEqual(["⋯ 16 unchanged lines", "⋯ 76 unchanged lines"]);
    const codeRows = s.rows.filter((r) => r.kind === "code").map((r) => text(r.line));
    expect(codeRows).toHaveLength(8); // 17..24 = range ±3
    expect(codeRows[3]).toMatch(/20 ▎\+ line 20/); // changed + in the focused range
    expect(codeRows[0]).toContain("17");
    const card = s.card.get("f1")!;
    expect(rows[card.from - 1]).toContain("line 21"); // directly after the finding's last line
    expect(rows[card.from]).toContain("╭─ ○ MAJ · correctness");
    expect(rows[card.to]).toMatch(/^ ╰─+╯$/);
  });

  it("merges windows that touch and keeps cards in order; far findings get a fold between", () => {
    const items = [view("a", 10), view("b", 14), view("c", 60)];
    const s = build(items, new Map([["a.ts", code(100)]]));
    expect(gaps(s.rows)).toEqual([
      "⋯ 6 unchanged lines",
      "⋯ 39 unchanged lines",
      "⋯ 37 unchanged lines",
    ]);
    const order = [...s.card.entries()].sort((x, y) => x[1].from - y[1].from).map(([id]) => id);
    expect(order).toEqual(["a", "b", "c"]);
    expect(s.card.get("a")!.to).toBeLessThan(s.card.get("b")!.from);
  });

  it("clamps findings past the end of the file and handles a one-line file", () => {
    const s = build([view("x", 50, 60)], new Map([["a.ts", code(5)]]));
    const codeRows = s.rows.filter((r) => r.kind === "code");
    expect(codeRows).toHaveLength(4); // lines 2..5: the window is cut at the end of the file
    expect(s.card.get("x")!.from).toBeGreaterThan(
      s.rows.findIndex((r) => text(r.line).includes("line 5")),
    );
  });

  it("without the file's code the cards still show, under the file name", () => {
    const s = build([view("f1", 3)], new Map());
    expect(s.rows.some((r) => r.kind === "code")).toBe(false);
    expect(text(s.rows[0]!.line)).toContain("a.ts");
    expect(s.card.has("f1")).toBe(true);
  });

  it("groups by file and every row fits the width", () => {
    const items = [view("a", 2), view("b", 2, 2, { file: "b.ts" })];
    const s = build(
      items,
      new Map([
        ["a.ts", code(10)],
        ["b.ts", code(10)],
      ]),
      { width: 60 },
    );
    expect(s.rows.filter((r) => r.kind === "file")).toHaveLength(2);
    for (const r of s.rows) expect(lineLen(r.line)).toBeLessThanOrEqual(61);
  });

  it("an expanded card carries the full explanation and the fix; a focused card shows its keys", () => {
    const item = view("f1", 3, 3, { failureScenario: "It fails when X.", ruleIds: ["R1"] });
    item.fix = {
      id: "x",
      findingId: "f1",
      author: "ai",
      summary: "Do the thing",
      patch: "--- a/a.ts\n+++ b/a.ts\n@@ -3,1 +3,2 @@\n line 3\n+added\n",
      active: true,
      overridden: false,
      createdAt: 0,
    } as FindingView["fix"];
    item.aiFix = item.fix!;
    const st = {
      rules: new Map([["R1", { id: "R1", title: "No X", path: "CLAUDE.md" }]]),
    } as unknown as SessionState;
    const s = build([item], new Map([["a.ts", code(10)]]), {
      state: st,
      expanded: new Set(["f1"]),
    });
    const body = s.rows.map((r) => text(r.line)).join("\n");
    for (const part of [
      "Explanation f1",
      "Fails when",
      "It fails when X.",
      "Rule  R1 No X",
      "CLAUDE.md",
      "AI ●",
      "Do the thing",
      "+ added",
      "[a] accept fix",
      "[enter] less",
    ])
      expect(body).toContain(part);
  });
});

describe("filters", () => {
  it("parseQuery reads sev:, lens:, file:, is:filtered and keeps the rest as words", () => {
    expect(parseQuery("")).toEqual({ tab: "findings" });
    expect(parseQuery("sev:major lens:security file:cart is:filtered null check")).toEqual({
      tab: "filtered",
      severity: "major",
      lens: "security",
      file: "cart",
      search: "null check",
    });
    expect(parseQuery("sev:bogus")).toEqual({ tab: "findings", search: "sev:bogus" });
  });

  it("visibleItems orders by file then line, hides skeptic-rejected, and filters", () => {
    const st = {
      items: [
        view("c", 30),
        view("a", 5),
        view("r", 1, 1, { verdict: "rejected" }),
        view("m", 9, 9, { severity: "nit", file: "0.ts" }),
      ],
    } as unknown as SessionState;
    expect(visibleItems(st, parseQuery("")).map((v) => v.finding.id)).toEqual(["m", "a", "c"]);
    expect(visibleItems(st, parseQuery("is:filtered")).map((v) => v.finding.id)).toEqual(["r"]);
    expect(visibleItems(st, parseQuery("sev:major")).map((v) => v.finding.id)).toEqual(["a", "c"]);
    expect(visibleItems(st, parseQuery("file:0.ts")).map((v) => v.finding.id)).toEqual(["m"]);
  });

  it("triage reads pending, accepted, dismissed and applied from a finding", () => {
    expect(triage(view("a", 1))).toBe("pending");
    expect(triage(view("a", 1, 1, { selected: true }))).toBe("accepted");
    expect(triage(view("a", 1, 1, { status: "dismissed" }))).toBe("dismissed");
    expect(triage(view("a", 1, 1, { status: "applied", selected: true }))).toBe("applied");
  });
});
