import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "@crit/providers";
import { createFixtureRepo } from "@crit/testkit";
import { describe, expect, it } from "vitest";

const CLI = join(import.meta.dirname, "..", "..", "dist", "index.js");
const live = process.env.CRIT_LIVE === "1";

const providers = [
  { type: "claude-code", command: "claude", model: "haiku" },
  { type: "codex", command: "codex", model: "default" },
  { type: "cursor", command: "cursor-agent", model: "default" },
];

for (const p of providers) {
  describe.skipIf(!live || !which(p.command))(`live: crit review with ${p.type}`, () => {
    it("finds the bug through the built CLI and leaves the tree untouched", () => {
      const repo = createFixtureRepo({
        "src/pay.ts": "export function refund(amount) {\n  return amount;\n}\n",
      });
      repo.git("checkout", "-q", "-b", "feature");
      repo.commit("feature", {
        "src/pay.ts":
          "export function refund(order, amount) {\n  try {\n    return order.provider.refund(amount);\n  } catch (e) {}\n  return { ok: true };\n}\n",
      });
      const home = mkdtempSync(join(tmpdir(), "crit-live-cli-"));
      const env = { ...process.env, CRIT_HOME: home, CI: "true", NO_COLOR: "1" };
      const run = (args: string[]) =>
        spawnSync(process.execPath, [CLI, ...args], {
          cwd: repo.root,
          env,
          encoding: "utf8",
          timeout: 600_000,
        });
      try {
        expect(
          run(["providers", "add", p.type, "--model", p.model, "--default", "--no-test"]).status,
        ).toBe(0);
        const r = run(["review", "--no-tui", "--format", "json"]);
        expect({ status: r.status, stderr: r.status === 0 ? "" : r.stderr }).toEqual({
          status: 0,
          stderr: "",
        });
        const doc = JSON.parse(r.stdout);
        expect(doc.review.status).toBe("completed");
        expect(doc.findings.some((f: { file: string }) => f.file === "src/pay.ts")).toBe(true);
        expect(repo.git("status", "--porcelain")).toBe("");
      } finally {
        repo.cleanup();
        rmSync(home, { recursive: true, force: true });
      }
    }, 620_000);
  });
}
