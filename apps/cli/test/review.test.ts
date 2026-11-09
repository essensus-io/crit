import type { ScopeSpec } from "@crit/schema";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFixtureRepo, type FixtureRepo } from "@crit/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { argsFromScope, parseTokens, scopeFromArgs } from "../src/commands/review.ts";
import { fakeProvidersJson, normalize, type TestEnv, testContext } from "./helpers.ts";

const FEATURE = `export async function refund(orders, provider, orderId, amount) {
  const order = await orders.get(orderId);
  try {
    await provider.refund(order.chargeId, amount);
  } catch (e) {}
  return order;
}
`;
const PATCH = `--- a/src/api/payments.ts
+++ b/src/api/payments.ts
@@ -1,4 +1,5 @@
 export async function refund(orders, provider, orderId, amount) {
   const order = await orders.get(orderId);
+  if (amount > order.captured) throw new Error("refund exceeds captured amount");
   try {
     await provider.refund(order.chargeId, amount);
`;

let repo: FixtureRepo;
let t: TestEnv;

beforeEach(() => {
  repo = createFixtureRepo({
    "src/api/payments.ts": "export const x = 1;\n",
    "README.md": "# shop\n",
  });
  repo.git("checkout", "-q", "-b", "feature/payments");
  repo.commit("feature", { "src/api/payments.ts": FEATURE });
  t = testContext({ cwd: repo.root });
  fakeProvidersJson(t);
  t.script({
    runs: [
      {
        match: { kind: "review" },
        repeat: true,
        calls: [
          {
            tool: "report_finding",
            args: {
              file: "src/api/payments.ts",
              range: { start: 4, end: 4 },
              anchor: "await provider.refund(order.chargeId, amount);",
              severity: "critical",
              category: "correctness",
              title: "Refund amount not validated",
              explanation: "refund() takes any amount.",
              failureScenario: "amount 5000 on a 2000 capture",
              confidence: 0.92,
              fix: { summary: "Validate amount", patch: PATCH },
            },
          },
          {
            tool: "report_finding",
            args: {
              file: "src/api/payments.ts",
              range: { start: 5, end: 5 },
              anchor: "} catch (e) {}",
              severity: "minor",
              category: "correctness",
              title: "Error swallowed in catch block",
              explanation: "Provider errors are ignored.",
              confidence: 0.6,
            },
          },
          { tool: "finish", args: { summary: "Looked at refunds." } },
        ],
      },
      {
        match: { kind: "skeptic" },
        repeat: true,
        skeptic: { default: "confirmed", byTitle: { "Error swallowed": "rejected" } },
      },
    ],
  });
});
afterEach(() => {
  t.cleanup();
  repo.cleanup();
});

describe("crit review --no-tui", () => {
  it("prints a text report with progress on stderr", async () => {
    expect(await t.run("review", "--no-tui")).toBe(0);
    expect(normalize(t.stdout(), t)).toMatchInlineSnapshot(`
      "crit · review <short> · feature/payments → main · agent · 1 finding · 1 selected · ~<tok> tokens · <dur>

      src/api/payments.ts
        [x] CRIT    4  Refund amount not validated  (fix)

      1 finding filtered by the skeptic (crit open <short> to see them)

      crit open <short> to review fixes · crit apply <short> to apply the 1 selected
      "
    `);
    const err = normalize(t.stderr(), t);
    expect(err).toContain("Plan   1 shard · est. <dur>");
    expect(err).toContain(
      "✓ feature/payments → main · correctness, security, performance, maintainability",
    );
    expect(err).toContain("Verifying 2 findings with the skeptic…");
  });

  it("exports JSON, Markdown and SARIF", async () => {
    expect(await t.run("review", "--no-tui", "--format", "json")).toBe(0);
    const doc = JSON.parse(t.stdout());
    expect(doc).toMatchObject({ format: "crit.review", version: 1 });
    expect(doc.findings).toHaveLength(2);

    const md = testContext({ cwd: repo.root });
    fakeProvidersJson(md);
    md.ctx.paths = t.ctx.paths;
    md.ctx.openStore = t.ctx.openStore;
    md.script({ runs: [] });
    expect(await md.run("review", "--no-tui", "--format", "md", "--no-verify")).toBe(0);
    const text = normalize(md.stdout(), md);
    expect(text).toContain("# crit review <short>");
    expect(text).toContain("- **Scope:** feature/payments → main");
    expect(text).toContain("### CRIT · Refund amount not validated");
    expect(text).toContain("**Fails when:** amount 5000 on a 2000 capture");
    expect(text).toContain("```diff\n--- a/src/api/payments.ts");
    md.cleanup();

    const sarifOut = join(repo.root, "crit.sarif");
    expect(await t.run("review", "--no-tui", "--format", "sarif", "-o", sarifOut)).toBe(0);
    const sarif = JSON.parse(readFileSync(sarifOut, "utf8"));
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results).toHaveLength(1);
    expect(sarif.runs[0].results[0]).toMatchObject({
      ruleId: "crit/correctness",
      level: "error",
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: "src/api/payments.ts" },
            region: { startLine: 4, endLine: 4 },
          },
        },
      ],
    });
    expect(t.stderr()).toContain("Wrote");
  });

  it("exits 3 with --fail-on when a finding meets the threshold", async () => {
    expect(await t.run("review", "--no-tui", "--fail-on", "major")).toBe(3);
    expect(await t.run("review", "--no-tui", "--fail-on", "major", "--lens", "style")).toBe(3);
  });

  it("rejects bad usage", async () => {
    for (const value of ["0", "-1", "1.5", "nope"])
      expect(await t.run("review", "--max-shards", value)).toBe(2);
    expect(await t.run("review", "--all", "--staged")).toBe(2);
    expect(t.stderr()).toContain("choose one scope");
    expect(await t.run("review", "--lens", "vibes")).toBe(2);
    expect(t.stderr()).toContain("unknown lens vibes");
    expect(await t.run("review", "--format", "xml")).toBe(2);
    expect(await t.run("review", "--fail-on", "huge")).toBe(2);
  });

  it("allows an explicit shard budget override without changing project settings", async () => {
    repo.commit("second file", { "src/api/b.ts": "export const b = 1;\n".repeat(30) });
    const config = { budget: { maxShards: 1 }, shardTokens: 100 };
    repo.write({ ".crit/config.json": JSON.stringify(config) });
    expect(await t.run("review", "--no-tui")).toBe(1);
    expect(t.stderr()).toContain("--max-shards");
    expect(await t.run("review", "--no-tui", "--max-shards", "100", "--no-verify")).toBe(0);
    expect(JSON.parse(readFileSync(join(repo.root, ".crit/config.json"), "utf8"))).toEqual(config);
  });

  it("asks for --yes before a whole-project review when not interactive", async () => {
    expect(await t.run("review", "--all", "--no-tui")).toBe(1);
    expect(t.stderr()).toMatch(
      /this review is 1 agent run, ~\d+k? tokens, ~1m30s on agent\. Pass --yes/,
    );
    expect(t.stderr()).toContain("crit review --dry-run shows what it would do");
  });

  it("asks before any review estimated above budget.confirmTokens, and --yes skips the ask", async () => {
    repo.write({ ".crit/config.json": JSON.stringify({ budget: { confirmTokens: 1 } }) });
    expect(await t.run("review", "--no-tui")).toBe(1);
    expect(t.stderr()).toContain("Pass --yes to start it");
    expect(await t.run("review", "--no-tui", "--yes")).toBe(0);
  });

  it("--dry-run shows files, skipped files with reasons, runs and the estimate, and calls no agent", async () => {
    repo.commit("noise", {
      "docs/guide.md": "# guide\n",
      "assets/Font-Bold.otf": "x",
      "src/api/b.ts": "export const b = 1;\n",
    });
    const calls = () => t.fakes.flatMap((f) => f.calls).length;
    expect(await t.run("review", "--dry-run")).toBe(0);
    const out = normalize(t.stdout(), t);
    expect(out).toContain(
      "crit review --dry-run · feature/payments → main · agent · depth standard",
    );
    expect(out).toMatch(/Files\s+2 to review · 0 cached · 2 skipped/);
    expect(out).toMatch(/1\s+docs, assets or generated \(default ignore\)/);
    expect(out).toMatch(/1\s+binary file/);
    expect(out).toContain("e.g. docs/guide.md (docs, assets or generated (default ignore))");
    expect(out).toMatch(/Runs \(1\)/);
    expect(out).toMatch(/Estimate\s+~\d+k? effective tokens · ~<dur> · stops at 2M/);
    expect(calls()).toBe(0);

    expect(await t.run("review", "--dry-run", "--format", "json")).toBe(0);
    const json = JSON.parse(t.stdout().slice(t.stdout().lastIndexOf('{\n  "scope"')));
    expect(json).toMatchObject({
      scope: "feature/payments → main",
      depth: "standard",
      files: { toReview: 2, cached: 0 },
      estimate: { budgetTokens: 2_000_000, confirmAboveTokens: 500_000 },
    });
    expect(json.skipped.byReason).toEqual({
      "docs, assets or generated (default ignore)": 1,
      "binary file": 1,
    });
    expect(calls()).toBe(0);
  });

  it("a dry run after a review shows the cache answering every file", async () => {
    expect(await t.run("review", "--no-tui")).toBe(0);
    expect(await t.run("review", "--dry-run")).toBe(0);
    const out = t.stdout().split("crit review --dry-run")[1]!;
    expect(out).toMatch(/Files\s+0 to review · 1 cached/);
    expect(out).toContain("Nothing to run: every file is answered by the cache.");
  });

  it("--budget stops the review: a partial review exits 4 and says how to resume", async () => {
    repo.commit("more", { "src/api/b.ts": "export const b = 1;\n" });
    repo.write({ ".crit/config.json": JSON.stringify({ shardTokens: 5, concurrency: 1 }) });
    expect(await t.run("review", "--no-tui", "--no-verify", "--budget", "1", "--no-cache")).toBe(4);
    expect(t.stderr()).toContain("Stopped: token budget reached");
    expect(t.stderr()).toMatch(/Stopped at the 1-token budget after 1 of 2 runs/);
    expect(t.stderr()).toMatch(/Stopped in .* · \d+ findings? reported · ~\d+k? effective tokens/);
    expect(await t.run("history", "--json")).toBe(0);
    expect(await t.run("review", "--budget", "lots")).toBe(2);
    expect(t.stderr()).toContain('cannot read "lots" as a token count');
    expect(await t.run("review", "--budget", "0")).toBe(2);
  });

  it("parses token counts", () => {
    expect([
      parseTokens("500000"),
      parseTokens("500k"),
      parseTokens("2M"),
      parseTokens("1.5m"),
    ]).toEqual([500_000, 500_000, 2_000_000, 1_500_000]);
  });

  it("uses --provider and warns about a missing project preference", async () => {
    repo.write({ ".crit/config.json": JSON.stringify({ provider: "team-claude" }) });
    expect(await t.run("review", "--no-tui", "--no-verify")).toBe(0);
    expect(t.stderr()).toContain('prefers provider "team-claude"');
    expect(await t.run("review", "--no-tui", "--provider", "nope")).toBe(1);
    expect(t.stderr()).toContain('no provider named "nope"');
  });

  it("explains first run without a terminal", async () => {
    const fresh = testContext({ cwd: repo.root });
    expect(await fresh.run("review")).toBe(1);
    expect(fresh.stderr()).toMatchInlineSnapshot(`
      "crit: no providers configured, and this is not an interactive terminal.
      Add one with:
        crit providers add claude-code --model opus --default
      "
    `);
    fresh.cleanup();
  });

  it("fails outside a git repository", async () => {
    const out = testContext();
    expect(await out.run("review")).toBe(1);
    expect(out.stderr()).toContain("not inside a git repository");
    out.cleanup();
  });

  it("maps flags to scopes", () => {
    expect(scopeFromArgs({ _: [] })).toEqual({ kind: "branch" });
    expect(scopeFromArgs({ _: [], base: "dev" })).toEqual({ kind: "branch", base: "dev" });
    expect(scopeFromArgs({ _: ["src", "**/*.sql"], diff: true })).toEqual({
      kind: "paths",
      paths: ["src", "**/*.sql"],
      diff: true,
    });
    expect(scopeFromArgs({ _: [], staged: true })).toEqual({ kind: "staged" });
    expect(scopeFromArgs({ _: [], commit: "abc" })).toEqual({ kind: "commit", sha: "abc" });
    expect(scopeFromArgs({ _: [], all: true })).toEqual({ kind: "project" });
  });
});

describe("argsFromScope", () => {
  it("turns every saved scope back into the arguments that review it again", () => {
    const specs: ScopeSpec[] = [
      { kind: "branch" },
      { kind: "branch", base: "develop" },
      { kind: "staged" },
      { kind: "commit", sha: "abc123" },
      { kind: "project" },
      { kind: "paths", paths: ["src", "lib/*.ts"], diff: true, base: "dev" },
      { kind: "paths", paths: ["src"], diff: false },
    ];
    for (const spec of specs) expect(scopeFromArgs(argsFromScope(spec))).toEqual(spec);
  });
});
