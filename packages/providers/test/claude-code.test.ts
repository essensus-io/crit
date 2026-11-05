import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentTask, ProviderProfile } from "@crit/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildClaudeInvocation,
  ClaudeCodeAdapter,
  claudeCodeFactory,
  ClaudeStreamParser,
  createDefaultRegistry,
} from "../src/index.ts";

const FIX = join(import.meta.dirname, "fixtures", "claude-code");
const replay = (file: string) => {
  const p = new ClaudeStreamParser("run `claude` once to log in");
  const events = readFileSync(join(FIX, file), "utf8")
    .trim()
    .split("\n")
    .flatMap((l) => p.line(l));
  return [...events, ...p.exit(0, false)];
};

const task = (over: Partial<AgentTask> = {}): AgentTask => ({
  kind: "review",
  cwd: "/repo",
  systemPrompt: "You are a reviewer.",
  prompt: "Review src/refund.ts",
  timeoutMs: 60_000,
  ...over,
});

const profile: ProviderProfile = {
  name: "claude",
  type: "claude-code",
  command: "claude",
  model: "opus",
  enabled: true,
};

describe("Claude Code stream-json contract (recorded transcripts)", () => {
  it("maps a review run with MCP tool calls to AgentEvents", () => {
    const all = replay("review.jsonl");
    // Running usage (one per API call) is checked separately; the rest is the contract.
    const events = all.filter((e) => !(e.type === "usage" && e.partial));
    expect(events.map((e) => e.type)).toEqual([
      "session",
      "tool",
      "progress",
      "tool",
      "tool",
      "tool",
      "progress",
      "usage",
      "message",
      "done",
    ]);
    expect(events[1]).toEqual({ type: "tool", name: "Read" });
    expect(events[2]).toEqual({ type: "progress", text: "reading refund.ts" });
    const partials = all.filter(
      (e): e is Extract<AgentEvent, { type: "usage" }> => e.type === "usage" && e.partial === true,
    );
    expect(partials.length).toBeGreaterThan(2);
    // cumulative: output never goes down, and the final figure matches the last running one
    const outs = partials.map((e) => e.outputTokens ?? 0);
    expect(outs).toEqual([...outs].sort((a, b) => a - b));
    const final = events.find((e) => e.type === "usage") as Extract<AgentEvent, { type: "usage" }>;
    expect(final.partial).toBeUndefined();
    expect(final.cachedInputTokens).toBeGreaterThan(0);
    // streamed per-message output counts are provisional; the final result is authoritative
    expect(final.outputTokens).toBeGreaterThanOrEqual(partials.at(-1)!.outputTokens ?? 0);
    expect(
      events.filter((e) => e.type === "tool").map((e) => (e as { name: string }).name),
    ).toEqual(["Read", "mcp__crit__get_scope", "mcp__crit__report_finding", "mcp__crit__finish"]);
    const usage = events.find((e) => e.type === "usage")!;
    expect(usage).toMatchObject({
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
    });
    expect((events.at(-2) as { text: string }).text).toMatch(/^I reported one finding/);
    expect(events.at(-1)).toEqual({ type: "done", exitCode: 0 });
  });

  it("maps a plain run without MCP", () => {
    const events = replay("simple.jsonl");
    expect(events).toContainEqual({ type: "message", text: "ok" });
    expect(events[0]).toEqual({ type: "session", id: "8fb66ed8-f1a0-4d5b-9af6-7c7c017661cd" });
  });

  it("the recorded run used only read-only tools plus crit's MCP tools", () => {
    const init = JSON.parse(readFileSync(join(FIX, "review.jsonl"), "utf8").split("\n")[0]!);
    expect(init.tools.sort()).toEqual([
      "Bash",
      "Glob",
      "Grep",
      "Read",
      "mcp__crit__finish",
      "mcp__crit__get_rules",
      "mcp__crit__get_scope",
      "mcp__crit__report_finding",
    ]);
    expect(init.permissionMode).toBe("dontAsk");
    expect(init.mcp_servers).toEqual([{ name: "crit", status: "connected", source: "dynamic" }]);
  });
});

describe("ClaudeStreamParser edge cases", () => {
  const parse = (lines: object[], exit = 0, timedOut = false) => {
    const p = new ClaudeStreamParser("run `claude` once to log in");
    return [...lines.flatMap((l) => p.line(JSON.stringify(l))), ...p.exit(exit, timedOut)];
  };

  it("reports a rejected rate limit with the retry delay", () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 60;
    const events = parse([
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt } },
      { type: "result", subtype: "success", result: "" },
    ]);
    const rl = events.find((e) => e.type === "rate-limited") as Extract<
      AgentEvent,
      { type: "rate-limited" }
    >;
    expect(rl.retryAfterMs).toBeGreaterThan(50_000);
    expect(
      parse([{ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }])[0],
    ).toEqual({ type: "rate-limited" });
    expect(
      parse([{ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }]).map(
        (e) => e.type,
      ),
    ).toEqual(["error", "done"]);
  });

  it("classifies error results: usage limit, login, other", () => {
    const err = (result: string) =>
      parse([{ type: "result", subtype: "success", is_error: true, result }]);
    expect(err("Claude AI usage limit reached|1793815200")[0]).toEqual({ type: "rate-limited" });
    expect(err("Invalid API key · Please run /login")[0]).toEqual({
      type: "error",
      message: "Invalid API key · Please run /login (run `claude` once to log in)",
    });
    expect(err("something broke")[0]).toEqual({
      type: "error",
      message: "claude: something broke",
    });
    expect(parse([{ type: "result", subtype: "error_max_turns" }])[0]).toEqual({
      type: "error",
      message: "claude: error_max_turns",
    });
  });

  it("flags an MCP server that failed to start", () => {
    const events = parse([
      { type: "system", subtype: "init", mcp_servers: [{ name: "crit", status: "failed" }] },
    ]);
    expect(events[0]).toEqual({
      type: "error",
      message: "crit MCP server did not start (status: failed)",
    });
  });

  it("describes tools and text, ignoring junk lines", () => {
    const p = new ClaudeStreamParser("hint");
    expect(p.line("not json")).toEqual([]);
    expect(p.line(JSON.stringify({ type: "user" }))).toEqual([]);
    const out = p.line(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Grep", input: { pattern: "refund" } },
            { type: "tool_use", name: "Glob", input: { pattern: "src/**/*.ts" } },
            { type: "tool_use", name: "Bash", input: { command: "git log -n 5 --oneline" } },
            { type: "tool_use", name: "Read", input: {} },
            { type: "tool_use", name: "mcp__crit__get_rules", input: {} },
            { type: "text", text: `Looking at the diff now${"!".repeat(100)}\nmore` },
            { type: "text", text: "   " },
          ],
        },
      }),
    );
    expect(
      out.filter((e) => e.type === "progress").map((e) => (e as { text: string }).text),
    ).toEqual([
      'searching "refund"',
      "listing src/**/*.ts",
      "running git log -n 5 --oneline",
      `Looking at the diff now${"!".repeat(56)}…`,
    ]);
  });

  it("explains exits without a result", () => {
    const exit = (stderr: string[], code = 1, timedOut = false) => {
      const p = new ClaudeStreamParser("run `claude` once to log in");
      p.stderr.push(...stderr);
      return p.exit(code, timedOut);
    };
    expect(exit(["Error: not logged in"])[0]).toEqual({
      type: "error",
      message: "Error: not logged in (run `claude` once to log in)",
    });
    expect(exit(["429 Too Many Requests"])[0]).toEqual({ type: "rate-limited" });
    expect(exit(["boom"], 2)).toEqual([
      { type: "error", message: "claude exited with code 2: boom" },
      { type: "done", exitCode: 2 },
    ]);
    expect(exit([], 3)[0]).toEqual({ type: "error", message: "claude exited with code 3" });
    expect(exit([], 143, true)).toEqual([
      { type: "error", message: "claude timed out" },
      { type: "done", exitCode: 124 },
    ]);
  });
});

describe("buildClaudeInvocation", () => {
  it("runs headless and read-only with the crit MCP server", () => {
    const inv = buildClaudeInvocation(
      profile,
      task({
        mcpSession: "s1",
        mcp: {
          command: "/usr/bin/node",
          args: ["/crit.js", "mcp", "--session", "s1"],
          sessionsDir: "/s",
        },
        allowedCommands: ["pnpm typecheck"],
      }),
      "/tmp/x",
    );
    const flag = (name: string) => inv.args[inv.args.indexOf(name) + 1];
    expect(inv.args.slice(0, 2)).toEqual(["-p", "--output-format"]);
    expect(flag("--output-format")).toBe("stream-json");
    expect(flag("--setting-sources")).toBe("");
    expect(flag("--permission-mode")).toBe("dontAsk");
    expect(inv.args).toContain("--strict-mcp-config");
    expect(inv.args).toContain("--no-session-persistence");
    expect(flag("--tools")).toBe("Read,Grep,Glob,Bash");
    expect(flag("--disallowedTools")!.split(",")).toEqual(
      expect.arrayContaining(["Edit", "Write", "WebFetch"]),
    );
    const allowed = flag("--allowedTools")!.split(",");
    expect(allowed).toEqual(
      expect.arrayContaining([
        "Read",
        "Bash(git log:*)",
        "Bash(pnpm typecheck)",
        "Bash(pnpm typecheck:*)",
        "mcp__crit",
      ]),
    );
    expect(allowed.some((a) => /Edit|Write/.test(a))).toBe(false);
    expect(flag("--model")).toBe("opus");
    expect(inv.stdin).toBe("Review src/refund.ts");
    const mcp = JSON.parse(inv.files.find((f) => f.path.endsWith("mcp.json"))!.content);
    expect(mcp).toEqual({
      mcpServers: {
        crit: {
          type: "stdio",
          command: "/usr/bin/node",
          args: ["/crit.js", "mcp", "--session", "s1"],
        },
      },
    });
    expect(inv.files.find((f) => f.path.endsWith("system.md"))!.content).toBe(
      "You are a reviewer.",
    );
    // replaces the default system prompt instead of appending to it
    expect(flag("--system-prompt-file")).toBe(join(inv.cleanupDir, "system.md"));
    expect(inv.args).not.toContain("--append-system-prompt-file");
    expect(flag("--mcp-config")).toBe(join(inv.cleanupDir, "mcp.json"));
  });

  it("gives each task only the tools it needs: none, read, or read plus shell", () => {
    const mcp = { command: "node", args: ["crit"], sessionsDir: "/s" };
    const build = (access?: "none" | "read" | "shell", allowedCommands?: string[]) => {
      const inv = buildClaudeInvocation(
        profile,
        task({
          mcpSession: "s",
          mcp,
          ...(access ? { access } : {}),
          ...(allowedCommands ? { allowedCommands } : {}),
        }),
        "/tmp/x",
      );
      const flag = (n: string) => inv.args[inv.args.indexOf(n) + 1];
      return { tools: flag("--tools"), allowed: flag("--allowedTools")?.split(",") };
    };
    expect(build("none")).toEqual({ tools: "", allowed: ["mcp__crit"] });
    expect(build("read")).toEqual({
      tools: "Read,Grep,Glob",
      allowed: ["Read", "Grep", "Glob", "mcp__crit"],
    });
    const shell = build("shell", ["pnpm test"]);
    expect(shell.tools).toBe("Read,Grep,Glob,Bash");
    expect(shell.allowed).toEqual(expect.arrayContaining(["Bash(git diff:*)", "Bash(pnpm test)"]));
    expect(build().tools).toBe("Read,Grep,Glob,Bash"); // default keeps the shell
    // no tools and no MCP (a skeptic on a JSON-only run): no allowlist flag at all
    const bare = buildClaudeInvocation(profile, task({ access: "none" }), "/tmp/x");
    expect(bare.args).not.toContain("--allowedTools");
    expect(bare.args[bare.args.indexOf("--tools") + 1]).toBe("");
  });

  it("omits MCP, system prompt and model when not given; task model wins", () => {
    const inv = buildClaudeInvocation(
      { command: "claude", model: null },
      task({ systemPrompt: "" }),
      "/tmp/x",
    );
    expect(inv.args).not.toContain("--mcp-config");
    expect(inv.args).not.toContain("--system-prompt-file");
    expect(inv.args).not.toContain("--model");
    expect(inv.files).toEqual([]);
    const m = buildClaudeInvocation(profile, task({ model: "haiku" }), "/tmp/x");
    expect(m.args[m.args.indexOf("--model") + 1]).toBe("haiku");
  });
});

describe("ClaudeCodeAdapter", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "crit-claude-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is registered with read-only capabilities and no native context", () => {
    const a = createDefaultRegistry().create(profile, { env: {}, tmpDir: dir });
    expect(a).toBeInstanceOf(ClaudeCodeAdapter);
    expect(a.capabilities).toMatchObject({ mcp: true, readOnlyMode: true, nativeContext: [] });
    expect(claudeCodeFactory.defaultCommand).toBe("claude");
  });

  it.skipIf(process.platform === "win32")(
    "spawns the CLI, streams events and cleans up temp files",
    async () => {
      // A stand-in `claude` that checks its stdin and replays the recorded transcript.
      const bin = join(dir, "claude");
      writeFileSync(
        bin,
        `#!${process.execPath}\nlet input='';process.stdin.on('data',d=>input+=d).on('end',()=>{\n` +
          `if(input!=='Review src/refund.ts'){console.error('bad stdin');process.exit(9)}\n` +
          `if(process.argv.includes('--version')){console.log('2.1.318 (Claude Code)');return}\n` +
          `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(FIX, "review.jsonl"))},'utf8'))})\n`,
      );
      chmodSync(bin, 0o755);
      const a = new ClaudeCodeAdapter(
        { ...profile, command: bin },
        { env: process.env, tmpDir: dir },
      );
      const events: AgentEvent[] = [];
      for await (const e of a.run(task({ cwd: dir }), new AbortController().signal)) events.push(e);
      expect(events.at(-1)).toEqual({ type: "done", exitCode: 0 });
      expect(events.filter((e) => e.type === "tool")).toHaveLength(4);
      expect(readdirSync(dir).filter((f) => f.startsWith("claude-"))).toEqual([]);

      const failing = new ClaudeCodeAdapter(
        { ...profile, command: bin },
        { env: process.env, tmpDir: dir },
      );
      const out: AgentEvent[] = [];
      for await (const e of failing.run(
        task({ cwd: dir, prompt: "other" }),
        new AbortController().signal,
      ))
        out.push(e);
      expect(out).toEqual([
        { type: "error", message: "claude exited with code 9: bad stdin" },
        { type: "done", exitCode: 9 },
      ]);
      expect(existsSync(bin)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")("detects a missing CLI", async () => {
    const a = new ClaudeCodeAdapter(
      { ...profile, command: join(dir, "nope") },
      { env: { PATH: dir }, tmpDir: dir },
    );
    expect(await a.detect()).toMatchObject({ installed: false });
  });
});
