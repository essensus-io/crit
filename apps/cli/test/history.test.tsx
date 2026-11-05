import { join } from "node:path";
import type { FakeScriptInput } from "@crit/providers";
import { createFixtureRepo, type FixtureRepo } from "@crit/testkit";
import { listHistory } from "@crit/store";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { outcomeOf, parseAge, parseSince } from "../src/commands/history.ts";
import { HistoryApp, previousOf } from "../src/tui/history.tsx";
import { ReviewSession } from "../src/tui/session.ts";
import { fakeProvidersJson, type TestEnv, testContext } from "./helpers.ts";

const FILE = ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;"].join("\n") + "\n";
const finding = (line: number, title: string, severity = "major") => ({
  tool: "report_finding",
  args: {
    file: "src/x.ts",
    range: { start: line, end: line },
    anchor: FILE.split("\n")[line - 1],
    severity,
    category: "correctness",
    title,
    explanation: "x",
    confidence: 0.8,
  },
});
const run = (calls: { tool: string; args: Record<string, unknown> }[]): FakeScriptInput => ({
  runs: [
    { match: { kind: "review" }, calls: [...calls, { tool: "finish", args: { summary: "ok" } }] },
  ],
});

let repo: FixtureRepo;
let t: TestEnv;

beforeEach(() => {
  repo = createFixtureRepo({ "src/x.ts": "// empty\n" });
  repo.git("checkout", "-q", "-b", "feature");
  repo.commit("x", { "src/x.ts": FILE });
  t = testContext({ cwd: repo.root });
  fakeProvidersJson(t);
});
afterEach(() => {
  t.cleanup();
  repo.cleanup();
});

async function review(script: FakeScriptInput, ...args: string[]) {
  t.script(script);
  expect(await t.run("review", "--no-tui", "--no-verify", "--no-cache", ...args)).toBe(0);
  return /review ([0-9a-f]{4})/.exec(t.stdout().split("crit · ").at(-1)!)![1]!;
}

describe("crit history", () => {
  it("lists reviews newest first with severity counts and outcomes; marks older runs superseded", async () => {
    expect(await t.run("history")).toBe(0);
    expect(t.stdout()).toContain("No reviews yet");
    const first = await review(run([finding(1, "Bug A", "critical"), finding(2, "Bug B")]));
    const second = await review(run([finding(2, "Bug B"), finding(3, "Bug C", "nit")]));
    expect(await t.run("apply", "--yes")).toBe(0);
    await review(run([finding(4, "Bug D", "minor")]), "src/x.ts");

    const before = t.stdout().length;
    expect(await t.run("history")).toBe(0);
    const rows = t
      .stdout()
      .slice(before)
      .split("\n")
      .filter((l) => /^\s+[0-9a-f]{4}\s/.test(l))
      .map((l) => l.trim().split(/\s{2,}/));
    expect(rows.map((r) => [r[0], r[2], r[4], r[6]])).toEqual([
      [rows[0]![0], "src/x.ts", "0C 0M 1m 0n", "open"],
      [second, "feature → main", "0C 1M 0m 1n", "open"],
      [first, "feature → main", "1C 1M 0m 0n", "superseded"],
    ]);
    expect(t.stdout()).toContain("C critical · M major · m minor · n nit");
  });

  it("compares two reviews: fixed, new and still open", async () => {
    const a = await review(
      run([
        finding(1, "Token logged in debug output"),
        finding(2, "Missing index on orders.user_id"),
      ]),
    );
    const b = await review(
      run([
        finding(2, "Missing index on orders.user_id"),
        finding(3, "Error swallowed in catch block"),
      ]),
    );
    const start = t.stdout().length;
    expect(await t.run("history", "--compare", a, b)).toBe(0);
    expect(t.stdout().slice(start)).toBe(
      [
        `  ${a} → ${b} · feature → main`,
        "",
        "  fixed         1   Token logged in debug output",
        "  new           1   Error swallowed in catch block",
        "  still open    1   --list to show them",
        "",
      ].join("\n"),
    );
    expect(await t.run("history", "--compare", b, a, "--list")).toBe(0);
    expect(t.stdout()).toContain("    src/x.ts:2  Missing index on orders.user_id");
    const mark = t.stdout().length;
    expect(await t.run("history", "--compare", a, b, "--json")).toBe(0);
    const json = JSON.parse(t.stdout().slice(mark));
    expect([json.fixed.length, json.new.length, json.stillOpen.length]).toEqual([1, 1, 1]);
    expect(await t.run("history", "--compare", a)).toBe(2);
  });

  it("filters, prints JSON, and lists every repo", async () => {
    await review(run([finding(1, "Bug A")]));
    await review(run([finding(1, "Bug A")]), "src");
    const mark = t.stdout().length;
    expect(await t.run("history", "--scope", "src", "--json")).toBe(0);
    const rows = JSON.parse(t.stdout().slice(mark));
    expect(rows.map((r: { review: { scopeLabel: string } }) => r.review.scopeLabel)).toEqual([
      "src",
    ]);
    expect(await t.run("history", "--branch", "nope", "--json")).toBe(0);
    expect(t.stdout().trimEnd().endsWith("[]")).toBe(true);
    expect(await t.run("history", "--provider", "agent", "--since", "1d")).toBe(0);
    expect(await t.run("history", "--all-repos")).toBe(0);
    expect(t.stdout()).toContain("REPO");
    expect(await t.run("history", "--since", "soon")).toBe(2);
  });

  it("deletes one review and prunes old ones", async () => {
    const a = await review(run([finding(1, "Bug A")]));
    const b = await review(run([finding(1, "Bug A")]), "src");
    expect(await t.run("history", "rm", a)).toBe(2);
    expect(await t.run("history", "rm", a, "--yes")).toBe(0);
    expect(t.stdout()).toContain(`Deleted review ${a}`);
    const store = t.ctx.openStore();
    const [row] = await listHistory(store.db, {});
    await store.reviews.update(row!.review.id, { startedAt: Date.now() - 100 * 86_400_000 });
    expect(await t.run("history", "prune")).toBe(2);
    expect(await t.run("history", "prune", "--older-than", "90d")).toBe(2);
    expect(await t.run("history", "prune", "--older-than", "90d", "--yes")).toBe(0);
    expect(t.stdout()).toContain("Deleted 1 review older than 90d");
    expect(await t.run("history", "prune", "--older-than", "90d", "--yes")).toBe(0);
    expect(t.stdout()).toContain("Nothing to prune.");
    void b;
  });

  it("parses ages and dates", () => {
    expect(parseAge("90d")).toBe(90 * 86_400_000);
    expect(parseAge("2w")).toBe(14 * 86_400_000);
    expect(parseAge("24h")).toBe(86_400_000);
    expect(() => parseAge("3 months")).toThrow(/90d/);
    expect(parseSince("2026-11-01", 0)).toBe(new Date("2026-11-01T00:00:00").getTime());
    expect(parseSince("1d", 86_400_000)).toBe(0);
  });
});

describe("history screen", () => {
  it("moves, compares with the previous run, filters, deletes and opens a review", async () => {
    const a = await review(run([finding(1, "Bug A"), finding(2, "Bug B")]));
    const b = await review(run([finding(2, "Bug B"), finding(3, "Bug C")]));
    const store = t.ctx.openStore();
    const rows = await listHistory(store.db, {});
    expect(previousOf(rows[0]!, rows)?.review.id.endsWith(a)).toBe(true);
    expect(outcomeOf(rows[1]!)).toBe("superseded");
    let removed = "";
    const app = render(
      <HistoryApp
        initial={rows}
        now={Date.now()}
        actions={{
          reload: async (q) => (q ? rows.filter((r) => r.review.scopeLabel.includes(q)) : rows),
          compare: async (row, all) => {
            const { compareReviews } = await import("../src/commands/history.ts");
            const prev = previousOf(row, all);
            return prev ? compareReviews(store, prev.review, row.review) : undefined;
          },
          remove: async (row) => void (removed = row.review.id),
          open: async (row) => {
            const s = new ReviewSession({
              store,
              root: repo.root,
              reviewId: row.review.id,
              editor: async () => undefined,
              backupRoot: join(t.dir, "b"),
              verifyCommands: [],
            });
            await s.load();
            return s;
          },
        }}
      />,
    );
    const sleep = (ms = 40) => new Promise((r) => setTimeout(r, ms));
    await sleep();
    expect(app.lastFrame()).toMatch(new RegExp(`› ${b}`));
    app.stdin.write("c");
    await sleep(150);
    expect(app.lastFrame()).toContain(`${a} → ${b}`);
    expect(app.lastFrame()).toMatch(/fixed\s+1\s+Bug A/);
    expect(app.lastFrame()).toMatch(/new\s+1\s+Bug C/);
    app.stdin.write("\u001B");
    await sleep(80);
    app.stdin.write("j");
    await sleep();
    app.stdin.write("c");
    await sleep(100);
    expect(app.lastFrame()).toContain("No earlier review of this scope to compare with.");
    app.stdin.write("d");
    await sleep();
    app.stdin.write("y");
    await sleep(80);
    expect(removed.endsWith(a)).toBe(true);
    expect(app.lastFrame()).toContain(`Deleted review ${a}`);
    app.stdin.write("/");
    await sleep();
    for (const ch of "zzz") app.stdin.write(ch);
    app.stdin.write("\r");
    await sleep(80);
    expect(app.lastFrame()).toContain("No reviews match.");
    app.stdin.write("/");
    await sleep();
    for (let i = 0; i < 3; i++) app.stdin.write("\u007F");
    app.stdin.write("\r");
    await sleep(80);
    app.stdin.write("\r");
    await sleep(200);
    expect(app.lastFrame()).toContain("FINDINGS");
    app.unmount();
  });
});
