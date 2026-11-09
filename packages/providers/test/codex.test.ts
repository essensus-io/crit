import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentTask, ProviderProfile } from "@crit/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCodexInvocation,
  CodexAdapter,
  codexFactory,
  CodexStreamParser,
  createDefaultRegistry,
} from "../src/index.ts";

const FIX = join(import.meta.dirname, "fixtures", "codex");
const profile: ProviderProfile = {
  name: "codex",
  type: "codex",
  command: "codex",
  model: null,
  enabled: true,
};
const task = (over: Partial<AgentTask> = {}): AgentTask => ({
  kind: "review",
  cwd: "/repo",
  systemPrompt: "You are a reviewer.",
  prompt: "Review src/refund.ts",
  timeoutMs: 60_000,
  ...over,
});

const parse = (lines: (object | string)[], exit = 0, timedOut = false) => {
  const p = new CodexStreamParser("run `codex login`");
  return [
    ...lines.flatMap((l) => p.line(typeof l === "string" ? l : JSON.stringify(l))),
    ...p.exit(exit, timedOut),
  ];
};

describe("Codex exec --json contract (recorded transcript)", () => {
  it("maps a review run with crit MCP tool calls to AgentEvents", () => {
    const events = parse(readFileSync(join(FIX, "review.jsonl"), "utf8").trim().split("\n"));
    expect(events[0]).toMatchObject({ type: "session" });
    const tools = events.filter((e) => e.type === "tool").map((e) => (e as { name: string }).name);
    expect(tools).toContain("mcp__crit__report_finding");
    expect(tools.at(-1)).toBe("mcp__crit__finish");
    expect(events.find((e) => e.type === "usage")).toMatchObject({
      inputTokens: expect.any(Number),
    });
    expect(events.at(-2)).toMatchObject({ type: "message" });
    expect(events.at(-1)).toEqual({ type: "done", exitCode: 0 });
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    const findings = JSON.parse(readFileSync(join(FIX, "review.findings.json"), "utf8"));
    expect(findings[0]).toMatchObject({ file: "src/refund.ts", category: "correctness" });
  });
});

describe("CodexStreamParser edge cases", () => {
  it("describes shell commands and failed MCP calls, ignoring junk", () => {
    const e = parse([
      {
        type: "item.started",
        item: { type: "command_execution", command: "/bin/zsh -lc 'git log -n 3'" },
      },
      {
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          tool: "report_finding",
          status: "failed",
          error: { message: "approval required" },
        },
      },
      { type: "item.completed", item: { type: "reasoning", text: "thinking" } },
      { type: "item.started", item: { type: "mcp_tool_call" } },
      "not json",
      { type: "turn.completed" },
    ]);
    expect(e.slice(0, 4)).toEqual([
      { type: "tool", name: "shell" },
      { type: "progress", text: "running /bin/zsh -lc 'git log -n 3'" },
      { type: "progress", text: "report_finding failed: approval required" },
      { type: "tool", name: "mcp__unknown__unknown" },
    ]);
    expect(e.at(-1)).toEqual({ type: "done", exitCode: 0 });
  });

  it("classifies failures: rate limits, login, other; exits without a turn", () => {
    expect(
      parse([{ type: "turn.failed", error: { message: "You've hit your usage limit." } }])[0],
    ).toEqual({ type: "rate-limited" });
    expect(parse([{ type: "error", message: "401 Unauthorized" }])[0]).toEqual({
      type: "error",
      message: "401 Unauthorized (run `codex login`)",
    });
    expect(parse([{ type: "error", error: { message: "boom" } }])[0]).toEqual({
      type: "error",
      message: "codex: boom",
    });
    expect(parse([{ type: "turn.failed" }])[0]).toEqual({
      type: "error",
      message: "codex: turn failed",
    });
    expect(parse([{ type: "error" }])[0]).toEqual({
      type: "error",
      message: "codex: unknown error",
    });
    expect(parse([], 2)).toEqual([
      { type: "error", message: "codex exited with code 2" },
      { type: "done", exitCode: 2 },
    ]);
    expect(parse([], 1, true)).toEqual([
      { type: "error", message: "codex timed out" },
      { type: "done", exitCode: 124 },
    ]);
    const p = new CodexStreamParser("hint");
    p.stderr.push("Error: Not logged in");
    expect(p.exit(1, false)[0]).toEqual({ type: "error", message: "Error: Not logged in (hint)" });
  });
});

describe("buildCodexInvocation", () => {
  it("runs exec read-only and ephemeral, with only crit's MCP tools pre-approved", () => {
    const inv = buildCodexInvocation(
      { command: "codex", model: "o4" },
      task({
        mcpSession: "s1",
        mcp: {
          command: "/usr/bin/node",
          args: ["/crit.js", "mcp", "--session", "s1"],
          sessionsDir: "/s",
        },
        outputSchema: { type: "object" },
      }),
      "/tmp/x",
    );
    expect(inv.args.slice(0, 2)).toEqual(["exec", "--json"]);
    const flag = (n: string) => inv.args[inv.args.indexOf(n) + 1];
    expect(flag("--sandbox")).toBe("read-only");
    expect(inv.args).toEqual(
      expect.arrayContaining([
        "--ephemeral",
        "--ignore-user-config",
        "project_doc_max_bytes=0",
        'approval_policy="never"',
      ]),
    );
    expect(inv.args).toContain('mcp_servers.crit.command="/usr/bin/node"');
    expect(inv.args).toContain('mcp_servers.crit.args=["/crit.js","mcp","--session","s1"]');
    expect(inv.args).toContain('mcp_servers.crit.default_tools_approval_mode="approve"');
    expect(inv.args.join(" ")).toContain("--disable plugins --disable apps");
    expect(flag("-m")).toBe("o4");
    expect(flag("-C")).toBe("/repo");
    expect(flag("--output-schema")).toBe(join(inv.cleanupDir, "schema.json"));
    expect(inv.args.at(-1)).toBe("-");
    expect(inv.stdin).toBe("You are a reviewer.\n\n---\n\nReview src/refund.ts");
  });

  it("omits optional parts", () => {
    const inv = buildCodexInvocation(
      { command: "codex", model: null },
      task({ systemPrompt: "" }),
      "/tmp/x",
    );
    expect(inv.args.join(" ")).not.toMatch(/mcp_servers|--output-schema| -m /);
    expect(inv.stdin).toBe("Review src/refund.ts");
  });
});

describe("CodexAdapter", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "crit-codex-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is registered with read-only capabilities and the JSON fallback", () => {
    const a = createDefaultRegistry().create(profile, { env: {}, tmpDir: dir });
    expect(a).toBeInstanceOf(CodexAdapter);
    expect(a.capabilities).toMatchObject({ mcp: true, jsonSchemaOutput: true, nativeContext: [] });
    expect(codexFactory.models).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "spawns the CLI and streams the recorded run",
    async () => {
      const bin = join(dir, "codex");
      writeFileSync(
        bin,
        `#!${process.execPath}\nlet i='';process.stdin.on('data',d=>i+=d).on('end',()=>{if(!i.endsWith('Review src/refund.ts'))process.exit(9);` +
          `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(FIX, "review.jsonl"))},'utf8'))})\n`,
      );
      chmodSync(bin, 0o755);
      const a = new CodexAdapter({ ...profile, command: bin }, { env: process.env, tmpDir: dir });
      const events: AgentEvent[] = [];
      for await (const e of a.run(
        task({ cwd: dir, outputSchema: { type: "object" } }),
        new AbortController().signal,
      ))
        events.push(e);
      expect(events.at(-1)).toEqual({ type: "done", exitCode: 0 });
      expect(readdirSync(dir).filter((f) => f.startsWith("codex-"))).toEqual([]);
      const missing = new CodexAdapter(
        { ...profile, command: join(dir, "nope") },
        { env: {}, tmpDir: dir },
      );
      expect((await missing.detect()).installed).toBe(false);
    },
  );
});
