import { createFakeAdapter, FakeScript } from "@crit/providers";
import { DEFAULT_CONFIG, type Finding, type Fix } from "@crit/schema";
import { describe, expect, it } from "vitest";
import { agentRebaser, extractDiff } from "../src/index.ts";

const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n";

describe("extractDiff", () => {
  it("takes a fenced or bare diff and rejects prose", () => {
    expect(extractDiff(`Here you go:\n\`\`\`diff\n${diff}\`\`\``)).toBe(diff);
    expect(extractDiff(`Sure.\n${diff}`)).toBe(diff);
    expect(extractDiff("I cannot do that.")).toBeUndefined();
    expect(extractDiff("--- a/x\nno hunks")).toBeUndefined();
  });
});

describe("agentRebaser", () => {
  it("asks the agent with the current file and parses its diff", async () => {
    const fake = createFakeAdapter(
      FakeScript.parse({
        runs: [
          { match: { kind: "draft-fix" }, message: `\`\`\`diff\n${diff}\`\`\`` },
          { match: { kind: "draft-fix" }, message: "no" },
        ],
      }),
      { model: null },
    );
    const rebase = agentRebaser(
      {
        profile: { name: "f", type: "fake", command: "x", model: "m", enabled: true },
        adapter: fake,
      },
      "/repo",
      DEFAULT_CONFIG,
    );
    const item = {
      finding: {
        title: "T",
        file: "x.ts",
        range: { start: 1, end: 1 },
        explanation: "E",
      } as Finding,
      fix: { patch: diff, summary: "S" } as Fix,
    };
    expect(await rebase(item, { "x.ts": "a\n" }, "patch failed")).toBe(diff);
    expect(fake.calls[0]!.task.prompt).toContain("File x.ts as it is now:\n```\na\n\n```");
    expect(fake.calls[0]!.task.prompt).toContain("git apply said: patch failed");
    expect(fake.calls[0]!.task.model).toBe("m");
    expect(await rebase(item, {}, "x")).toBeUndefined();
  });
});
