import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFixtureRepo, type FixtureRepo } from "@crit/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeProvidersJson, normalize, type TestEnv, testContext } from "./helpers.ts";

const FEATURE = "export function refund(amount) {\n  const fee = 0;\n  return amount;\n}\n";
const PATCH =
  '--- a/src/pay.ts\n+++ b/src/pay.ts\n@@ -1,4 +1,5 @@\n export function refund(amount) {\n+  if (amount <= 0) throw new Error("bad amount");\n   const fee = 0;\n   return amount;\n }\n';

let repo: FixtureRepo;
let t: TestEnv;

beforeEach(() => {
  repo = createFixtureRepo({
    "src/pay.ts": "export function refund(amount) {\n  return amount;\n}\n",
  });
  repo.git("checkout", "-q", "-b", "feature");
  repo.commit("feature", { "src/pay.ts": FEATURE });
  t = testContext({ cwd: repo.root });
  fakeProvidersJson(t);
  t.script({
    runs: [
      {
        match: { kind: "review" },
        calls: [
          {
            tool: "report_finding",
            args: {
              file: "src/pay.ts",
              range: { start: 2, end: 2 },
              anchor: "const fee = 0;",
              severity: "major",
              category: "correctness",
              title: "Amount not validated",
              explanation: "Negative refunds pass.",
              confidence: 0.9,
              fix: { summary: "Reject non-positive amounts", patch: PATCH },
            },
          },
          { tool: "finish", args: { summary: "done" } },
        ],
      },
      { match: { kind: "skeptic" }, skeptic: { default: "confirmed" } },
    ],
  });
});
afterEach(() => {
  t.cleanup();
  repo.cleanup();
});

const read = () => readFileSync(join(repo.root, "src/pay.ts"), "utf8");

describe("crit apply, undo and open", () => {
  it("applies checked fixes to the working tree and undoes them exactly", async () => {
    expect(await t.run("review", "--no-tui")).toBe(0);
    expect(await t.run("apply", "--yes")).toBe(0);
    expect(normalize(t.stdout().split(/to apply the 1 selected\n/)[1]!, t)).toMatchInlineSnapshot(`
      "Applying 1 fix from review <short> → working tree
        src/pay.ts:2  Amount not validated
      ✓ src/pay.ts:2  Amount not validated
      Backup saved; \`crit undo\` restores the files.
      "
    `);
    expect(read()).toContain('throw new Error("bad amount")');
    expect(await t.run("apply")).toBe(0);
    expect(t.stdout()).toContain("No checked fixes in review");

    expect(await t.run("undo")).toBe(0);
    expect(read()).toBe(FEATURE);
    expect(repo.git("status", "--porcelain")).toBe("");
    expect(t.stdout()).toMatch(/Restored 1 file \(review [0-9a-f]{4}\)/);
    expect(await t.run("undo")).toBe(1);
    expect(t.stderr()).toContain("nothing to undo");
  });

  it("commits to a fixes branch and runs verify commands", async () => {
    repo.write({
      ".crit/config.json": JSON.stringify({ verify: { commands: ["git log -1 --format=%s"] } }),
    });
    repo.commit("config");
    expect(await t.run("review", "--no-tui")).toBe(0);
    expect(await t.run("apply", "--branch", "--yes")).toBe(0);
    expect(t.stdout()).toMatch(
      /Committed to crit\/fixes-[0-9a-f]{4}\. Your working tree was not changed\./,
    );
    expect(t.stdout()).toMatch(/✓ git log -1 --format=%s/);
    expect(read()).toBe(FEATURE);
    const branch = /crit\/fixes-[0-9a-f]{4}/.exec(t.stdout())![0];
    expect(repo.git("log", "-1", "--format=%s", branch)).toBe("crit: Amount not validated");
    expect(await t.run("undo")).toBe(0);
    expect(t.stdout()).toContain(`Deleted branch ${branch}`);
    expect(await t.run("review", "--no-tui")).toBe(0);
    expect(await t.run("apply", "--branch-name", "my-fixes", "--squash", "-y")).toBe(0);
    expect(repo.git("log", "-1", "--format=%s", "my-fixes")).toMatch(
      /^crit: apply 1 fix from review/,
    );
  });

  it("reports a failing verify command with exit 1", async () => {
    repo.write({
      ".crit/config.json": JSON.stringify({ verify: { commands: ["echo broken && exit 4"] } }),
    });
    repo.commit("config");
    expect(await t.run("review", "--no-tui")).toBe(0);
    expect(await t.run("apply", "-y")).toBe(1);
    expect(t.stdout()).toContain("✗ echo broken && exit 4");
    expect(t.stdout()).toContain("broken");
  });

  it("reopens a saved review by short id and errors on unknown ids", async () => {
    expect(await t.run("open")).toBe(1);
    expect(t.stderr()).toContain("no reviews of this repository yet");
    expect(await t.run("review", "--no-tui")).toBe(0);
    const id = /review ([0-9a-f]{4})/.exec(t.stdout())![1]!;
    expect(await t.run("open", id)).toBe(0);
    expect(t.stdout().split(`review ${id}`)).toHaveLength(3);
    expect(await t.run("open", "zzzz")).toBe(1);
    expect(t.stderr()).toContain("no review matches zzzz");
  });

  it("asks before applying in a terminal", async () => {
    const i = testContext({ cwd: repo.root, interactive: true, answers: [false] });
    i.ctx.paths = t.ctx.paths;
    i.ctx.openStore = t.ctx.openStore;
    expect(await t.run("review", "--no-tui")).toBe(0);
    expect(await i.run("apply")).toBe(130);
    expect(read()).toBe(FEATURE);
    i.cleanup();
  });
});
