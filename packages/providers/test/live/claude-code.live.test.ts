/**
 * Live smoke test: one tiny read-only review through the real Claude Code CLI
 * and the crit MCP server. Opt-in: `pnpm test:live` (CRIT_LIVE=1). Never in CI.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionHandler, startSessionHost } from "@crit/mcp";
import type { AgentEvent, FindingInput } from "@crit/schema";
import { createFixtureRepo } from "@crit/testkit";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, which } from "../../src/index.ts";

const enabled = process.env.CRIT_LIVE === "1" && which("claude") !== undefined;

describe.skipIf(!enabled)("live: claude-code", () => {
  it("reviews a buggy file and reports a finding through MCP", async () => {
    const repo = createFixtureRepo({
      "src/refund.ts":
        "export function refund(order: { captured: number }, amount: number) {\n  return { refunded: amount };\n}\n",
    });
    const dir = mkdtempSync(join(tmpdir(), "crit-live-"));
    const findings: FindingInput[] = [];
    const handler: SessionHandler = {
      getScope: async () => ({
        label: "src/refund.ts",
        files: [{ path: "src/refund.ts", status: "unchanged" }],
        notes: "",
      }),
      getRules: async () => [],
      reportFinding: async (f) => {
        findings.push(f);
        return { accepted: true, id: `f${findings.length}` };
      },
      finish: async () => ({ ok: true }),
    };
    const host = await startSessionHost({ handler, dir });
    try {
      const adapter = new ClaudeCodeAdapter(
        { name: "claude", type: "claude-code", command: "claude", model: "haiku", enabled: true },
        { env: process.env, tmpDir: dir },
      );
      const detected = await adapter.detect();
      expect(detected.installed).toBe(true);
      const events: AgentEvent[] = [];
      for await (const e of adapter.run(
        {
          kind: "review",
          cwd: repo.root,
          systemPrompt:
            "You are a code reviewer. Report issues only with the crit report_finding tool, then call finish.",
          prompt:
            "Review src/refund.ts. Report the most important bug with report_finding, then call finish.",
          mcpSession: host.sessionId,
          mcp: {
            command: process.execPath,
            args: [
              join(import.meta.dirname, "../../../../scripts/mcp-entry.ts"),
              dir,
              host.sessionId,
            ],
            sessionsDir: dir,
          },
          timeoutMs: 180_000,
        },
        new AbortController().signal,
      )) {
        events.push(e);
      }
      expect(events.filter((e) => e.type === "error")).toEqual([]);
      expect(events.at(-1)).toEqual({ type: "done", exitCode: 0 });
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]!.file).toBe("src/refund.ts");
    } finally {
      await host.close();
      repo.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 200_000);
});
