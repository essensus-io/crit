/**
 * End-to-end: spawn the built CLI (dist/index.js) with a temporary crit home
 * and the fake provider, the way a user runs it. No network, real git.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSessionHost } from "@crit/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createFixtureRepo, type FixtureRepo } from "@crit/testkit";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const CLI = join(import.meta.dirname, "..", "dist", "index.js");

beforeAll(() => {
  if (!existsSync(CLI))
    execFileSync("pnpm", ["--filter", "@crit/cli", "build"], {
      stdio: "ignore",
      shell: process.platform === "win32",
    });
}, 120_000);

const FEATURE = "export function refund(amount) {\n  const fee = 0;\n  return amount;\n}\n";
const PATCH =
  '--- a/src/pay.ts\n+++ b/src/pay.ts\n@@ -1,4 +1,5 @@\n export function refund(amount) {\n+  if (amount <= 0) throw new Error("bad amount");\n   const fee = 0;\n   return amount;\n }\n';
const SCRIPT = {
  runs: [
    {
      match: { kind: "review" },
      repeat: true,
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
        { tool: "finish", args: { summary: "Checked refunds." } },
      ],
    },
    { match: { kind: "skeptic" }, repeat: true, skeptic: { default: "confirmed" } },
  ],
};

let repo: FixtureRepo;
let home: string;

beforeEach(() => {
  repo = createFixtureRepo({
    "src/pay.ts": "export function refund(amount) {\n  return amount;\n}\n",
  });
  repo.git("checkout", "-q", "-b", "feature");
  repo.commit("feature", { "src/pay.ts": FEATURE });
  home = mkdtempSync(join(tmpdir(), "crit-e2e-"));
});
afterEach(() => {
  repo.cleanup();
  rmSync(home, { recursive: true, force: true });
});

function crit(args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? repo.root,
    env: {
      ...process.env,
      CRIT_HOME: join(home, "crit"),
      CRIT_FAKE_HOME: join(home, "user"),
      NO_COLOR: "1",
      CI: "true",
      ...opts.env,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function useFake() {
  const script = join(home, "script.json");
  writeFileSync(script, JSON.stringify(SCRIPT));
  mkdirSync(join(home, "crit", "config"), { recursive: true });
  writeFileSync(
    join(home, "crit", "config", "providers.json"),
    JSON.stringify({
      default: "fake",
      providers: [{ name: "fake", type: "fake", command: script, model: null, enabled: true }],
      roles: {},
    }),
  );
}

describe("built CLI", () => {
  it("prints help and version", () => {
    const help = crit(["--help"]);
    expect(help.code).toBe(0);
    for (const cmd of [
      "review",
      "open",
      "apply",
      "undo",
      "history",
      "providers",
      "rules",
      "doctor",
      "init",
      "mcp",
    ])
      expect(help.out).toContain(cmd);
    expect(crit(["--version"]).out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(crit(["nope"]).code).toBe(2);
  });

  it("explains first run without a terminal", () => {
    const r = crit(["review"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no providers configured, and this is not an interactive terminal");
    expect(r.err).toContain("crit providers add claude-code --model opus --default");
  });

  it("reviews, applies, undoes and keeps history, end to end", () => {
    useFake();
    const review = crit(["review", "--no-tui"]);
    expect(review.code).toBe(0);
    expect(review.out).toMatch(/\[x\] MAJ\s+2\s+Amount not validated\s+\(fix\)/);
    expect(review.err).toContain("Verifying 1 finding with the skeptic");

    const json = crit(["review", "--no-tui", "--format", "json"]);
    expect(JSON.parse(json.out)).toMatchObject({
      format: "crit.review",
      findings: [{ title: "Amount not validated", verdict: "confirmed", selected: true }],
    });
    const sarif = crit(["review", "--no-tui", "--format", "sarif"]);
    expect(JSON.parse(sarif.out).runs[0].results).toHaveLength(1);
    expect(crit(["review", "--no-tui", "--fail-on", "major"]).code).toBe(3);

    expect(crit(["apply", "--yes"]).code).toBe(0);
    expect(readFileSync(join(repo.root, "src/pay.ts"), "utf8")).toContain(
      'throw new Error("bad amount")',
    );
    expect(crit(["undo"]).code).toBe(0);
    expect(readFileSync(join(repo.root, "src/pay.ts"), "utf8")).toBe(FEATURE);

    const history = crit(["history"]);
    expect(history.code).toBe(0);
    expect(history.out).toMatch(/feature → main\s+fake\s+0C 1M 0m 0n\s+open/);
    expect(history.out).toContain("superseded");
    expect(crit(["open", "--no-tui"]).out).toContain("Amount not validated");
  });

  it("lists providers, rules and doctor output", () => {
    useFake();
    repo.write({ "CLAUDE.md": "## Errors\n\nNever swallow errors.\n" });
    expect(crit(["providers"]).out).toMatch(/● fake\s+fake/);
    expect(crit(["rules"]).out).toMatch(/R1\s+project\s+all files\s+Errors\s+CLAUDE\.md §Errors/);
    const doctor = crit(["doctor"]);
    expect(doctor.out).toContain("✓ node");
    expect(doctor.out).toContain("providers.json");
  });

  it("serves crit mcp --session over stdio, as agents start it (even without CRIT_HOME)", async () => {
    const sessions = join(home, "crit", "cache", "sessions");
    const reported: unknown[] = [];
    const host = await startSessionHost({
      dir: sessions,
      handler: {
        getScope: async () => ({ label: "x", files: [], notes: "" }),
        getRules: async () => [],
        reportFinding: async (f) => {
          reported.push(f);
          return { accepted: true, id: "f1" };
        },
        finish: async () => ({ ok: true }),
      },
    });
    const client = new Client({ name: "e2e", version: "1" });
    try {
      await client.connect(
        // Started like Codex does: a reduced environment without CRIT_HOME, so the
        // sessions folder must come from --sessions-dir (regression).
        new StdioClientTransport({
          command: process.execPath,
          args: [CLI, "mcp", "--session", host.sessionId, "--sessions-dir", sessions],
          env: { PATH: process.env.PATH ?? "", HOME: join(home, "elsewhere") },
        }),
      );
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
        "get_scope",
        "get_rules",
        "report_finding",
        "finish",
      ]);
      const r = await client.callTool({ name: "finish", arguments: { summary: "done" } });
      expect((r.content as { text: string }[])[0]!.text).toBe("Shard finished. Stop now.");
    } finally {
      await client.close();
      await host.close();
    }
  }, 30_000);
});
