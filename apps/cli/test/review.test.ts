import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFixtureRepo, type FixtureRepo } from "@crit/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scopeFromArgs } from "../src/commands/review.ts";
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
      "crit · review <short> · feature/payments → main · agent · 1 finding · 1 selected · <dur>

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
    // reuse the cache from the first run: no agent calls needed
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
    expect(await t.run("review", "--all", "--staged")).toBe(2);
    expect(t.stderr()).toContain("choose one scope");
    expect(await t.run("review", "--lens", "vibes")).toBe(2);
    expect(t.stderr()).toContain("unknown lens vibes");
    expect(await t.run("review", "--format", "xml")).toBe(2);
    expect(await t.run("review", "--fail-on", "huge")).toBe(2);
  });

  it("asks for --yes before a whole-project review when not interactive", async () => {
    expect(await t.run("review", "--all", "--no-tui")).toBe(1);
    expect(t.stderr()).toMatch(/whole-project review runs 1 shard .* Pass --yes/);
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
