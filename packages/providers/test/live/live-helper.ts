import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionHandler, startSessionHost } from "@crit/mcp";
import type { AgentEvent, FindingInput } from "@crit/schema";
import { createFixtureRepo } from "@crit/testkit";
import { expect, it } from "vitest";
import type { ProviderAdapter } from "../../src/index.ts";

export function liveReview(make: (tmpDir: string) => ProviderAdapter) {
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
      const adapter = make(dir);
      expect((await adapter.detect()).installed).toBe(true);
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
          timeoutMs: 280_000,
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
  }, 300_000);
}
