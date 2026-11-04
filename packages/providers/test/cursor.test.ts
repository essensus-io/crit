import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentTask, ProviderProfile } from "@crit/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCursorInvocation,
  CursorAdapter,
  CursorStreamParser,
  createDefaultRegistry,
} from "../src/index.ts";

const FIX = join(import.meta.dirname, "fixtures", "cursor");
const profile: ProviderProfile = {
  name: "cursor",
  type: "cursor",
  command: "cursor-agent",
  model: null,
  enabled: true,
};
const task = (over: Partial<AgentTask> = {}): AgentTask => ({
  kind: "review",
  cwd: "/repo",
  systemPrompt: "Reply with JSON.",
  prompt: "Review src/refund.ts",
  timeoutMs: 60_000,
  ...over,
});
const parse = (lines: (object | string)[], exit = 0, timedOut = false) => {
  const p = new CursorStreamParser("run `cursor-agent login`");
  return [
    ...lines.flatMap((l) => p.line(typeof l === "string" ? l : JSON.stringify(l))),
    ...p.exit(exit, timedOut),
  ];
};

describe("cursor-agent stream-json contract (recorded transcript)", () => {
  it("maps a read-only ask-mode review with a JSON reply", () => {
    const events = parse(readFileSync(join(FIX, "review.jsonl"), "utf8").trim().split("\n"));
    expect(events[0]).toMatchObject({ type: "session" });
    expect(
      events.filter((e) => e.type === "tool").map((e) => (e as { name: string }).name),
    ).toContain("read");
    expect(events.some((e) => e.type === "progress" && e.text === "reading refund.ts")).toBe(true);
    const msg = events.find(
      (e): e is Extract<AgentEvent, { type: "message" }> => e.type === "message",
    )!;
    expect(
      JSON.parse(msg.text.slice(msg.text.indexOf("{"), msg.text.lastIndexOf("}") + 1)).findings[0]
        .file,
    ).toBe("src/refund.ts");
    expect(events.at(-1)).toEqual({ type: "done", exitCode: 0 });
    expect(events.filter((e) => e.type === "error")).toEqual([]);
  });
});

describe("CursorStreamParser edge cases", () => {
  it("describes grep and glob calls and assistant text", () => {
    const e = parse([
      {
        type: "tool_call",
        subtype: "started",
        tool_call: { grepToolCall: { args: { pattern: "refund" } } },
      },
      {
        type: "tool_call",
        subtype: "started",
        tool_call: { globToolCall: { args: { globPattern: "src/**" } } },
      },
      { type: "tool_call", subtype: "started", tool_call: { shellToolCall: { args: {} } } },
      { type: "tool_call", subtype: "started", tool_call: { other: {} } },
      { type: "assistant", message: { content: [{ type: "text", text: "Looking now\nmore" }] } },
      "junk",
      { type: "result", subtype: "success", result: "{}" },
    ]);
    expect(e.slice(0, 6)).toEqual([
      { type: "tool", name: "grep" },
      { type: "progress", text: "searching refund" },
      { type: "tool", name: "glob" },
      { type: "progress", text: "listing src/**" },
      { type: "tool", name: "shell" },
      { type: "progress", text: "Looking now" },
    ]);
  });

  it("classifies errors and exits without a result", () => {
    expect(
      parse([
        { type: "result", subtype: "error", is_error: true, result: "Usage limit reached" },
      ])[0],
    ).toEqual({ type: "rate-limited" });
    expect(
      parse([{ type: "result", is_error: true, subtype: "error", result: "Not logged in" }])[0],
    ).toEqual({ type: "error", message: "Not logged in (run `cursor-agent login`)" });
    expect(parse([{ type: "result", subtype: "error" }])[0]).toEqual({
      type: "error",
      message: "cursor: error",
    });
    expect(parse([], 3)).toEqual([
      { type: "error", message: "cursor-agent exited with code 3" },
      { type: "done", exitCode: 3 },
    ]);
    expect(parse([], 1, true)[0]).toEqual({ type: "error", message: "cursor-agent timed out" });
    const p = new CursorStreamParser("hint");
    p.stderr.push("boom");
    expect(p.exit(1, false)[0]).toEqual({ type: "error", message: "cursor: boom" });
  });
});

describe("buildCursorInvocation and adapter", () => {
  it("runs print mode in read-only ask mode with the sandbox on", () => {
    const inv = buildCursorInvocation({ command: "cursor-agent", model: "sonnet-4" }, task());
    expect(inv.args).toEqual([
      "-p",
      "--mode",
      "ask",
      "--output-format",
      "stream-json",
      "--trust",
      "--sandbox",
      "enabled",
      "--workspace",
      "/repo",
      "--model",
      "sonnet-4",
    ]);
    expect(inv.stdin).toBe("Reply with JSON.\n\n---\n\nReview src/refund.ts");
    expect(
      buildCursorInvocation({ command: "c", model: null }, task({ systemPrompt: "" })).stdin,
    ).toBe("Review src/refund.ts");
  });

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "crit-cursor-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("uses the JSON fallback and declares the rules Cursor loads itself", () => {
    const a = createDefaultRegistry().create(profile, { env: {}, tmpDir: dir });
    expect(a).toBeInstanceOf(CursorAdapter);
    expect(a.capabilities).toMatchObject({
      mcp: false,
      readOnlyMode: true,
      nativeContext: ["cursor-rule", "cursorrules", "agents-md", "claude-md"],
    });
  });

  it.skipIf(process.platform === "win32")(
    "spawns the CLI and streams the recorded run",
    async () => {
      const bin = join(dir, "cursor-agent");
      writeFileSync(
        bin,
        `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(FIX, "review.jsonl"))},'utf8')))\n`,
      );
      chmodSync(bin, 0o755);
      const events: AgentEvent[] = [];
      for await (const e of new CursorAdapter(
        { ...profile, command: bin },
        { env: process.env, tmpDir: dir },
      ).run(task({ cwd: dir }), new AbortController().signal))
        events.push(e);
      expect(events.at(-1)).toEqual({ type: "done", exitCode: 0 });
      expect(
        (
          await new CursorAdapter(
            { ...profile, command: join(dir, "nope") },
            { env: {}, tmpDir: dir },
          ).detect()
        ).installed,
      ).toBe(false);
    },
  );
});
