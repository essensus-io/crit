import { describe, expect, it } from "vitest";
import { createCursorAdapter, which } from "../../src/index.ts";
import type { AgentEvent } from "@crit/schema";
import { createFixtureRepo } from "@crit/testkit";

describe.skipIf(!(process.env.CRIT_LIVE === "1" && which("cursor-agent")))("live: cursor", () => {
  it("reviews a buggy file and replies with finding JSON", async () => {
    const repo = createFixtureRepo({
      "src/refund.ts":
        "export function refund(order: { captured: number }, amount: number) {\n  return { refunded: amount };\n}\n",
    });
    try {
      const a = createCursorAdapter(
        { name: "cursor", type: "cursor", command: "cursor-agent", model: null, enabled: true },
        { env: process.env, tmpDir: repo.root },
      );
      const events: AgentEvent[] = [];
      for await (const e of a.run(
        {
          kind: "review",
          cwd: repo.root,
          systemPrompt:
            'Reply with ONLY {"findings": [{"file": "...", "title": "..."}], "summary": "..."}',
          prompt: "Review src/refund.ts for its most important bug.",
          timeoutMs: 280_000,
        },
        new AbortController().signal,
      ))
        events.push(e);
      expect(events.at(-1)).toEqual({ type: "done", exitCode: 0 });
      const msg = events.find(
        (e): e is Extract<AgentEvent, { type: "message" }> => e.type === "message",
      );
      expect(msg?.text).toContain("src/refund.ts");
      expect(repo.git("status", "--porcelain")).toBe("");
    } finally {
      repo.cleanup();
    }
  }, 300_000);
});
