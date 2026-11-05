import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentEvent, AgentTask, ProviderProfile } from "@crit/schema";
import type { AdapterEnv, AdapterFactory, ProviderAdapter } from "../adapter.ts";
import { detectCli } from "../detect.ts";
import { streamProcess } from "../process.ts";

/** Versions the contract tests were recorded against. */
export const CLAUDE_TESTED = { min: "2.1.0", max: "2.1.999" };

/** Read-only git commands every reviewer may run. */
export const GIT_READ_COMMANDS = [
  "git log",
  "git show",
  "git diff",
  "git blame",
  "git status",
  "git ls-files",
  "git grep",
  "git rev-parse",
];

const DISALLOWED = ["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task", "TodoWrite"];

export type Invocation = {
  command: string;
  args: string[];
  stdin: string;
  files: { path: string; content: string }[];
  cleanupDir: string;
};

/**
 * Build the headless, read-only invocation:
 * - `--setting-sources ""`: no user/project settings, so no permission rule
 *   from the repo can widen the tool allowlist. It also means Claude Code does
 *   not load CLAUDE.md itself; crit inlines it (nativeContext is empty).
 * - `--tools` limits the built-in tool set; Edit/Write do not exist in the run.
 * - `--permission-mode dontAsk` denies anything not in `--allowedTools`.
 */
export function buildClaudeInvocation(
  profile: Pick<ProviderProfile, "command" | "model">,
  task: AgentTask,
  tmpDir: string,
): Invocation {
  const dir = join(tmpDir, `claude-${randomBytes(4).toString("hex")}`);
  const files: Invocation["files"] = [];
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--permission-mode",
    "dontAsk",
    "--strict-mcp-config",
  ];
  if (task.mcp && task.mcpSession) {
    const mcpFile = join(dir, "mcp.json");
    files.push({
      path: mcpFile,
      content: JSON.stringify({
        mcpServers: { crit: { type: "stdio", command: task.mcp.command, args: task.mcp.args } },
      }),
    });
    args.push("--mcp-config", mcpFile);
  }
  if (task.systemPrompt) {
    const promptFile = join(dir, "system.md");
    files.push({ path: promptFile, content: task.systemPrompt });
    args.push("--append-system-prompt-file", promptFile);
  }
  const bashRules = [...GIT_READ_COMMANDS, ...(task.allowedCommands ?? [])].flatMap((c) => [
    `Bash(${c})`,
    `Bash(${c}:*)`,
  ]);
  args.push("--tools", "Read,Grep,Glob,Bash");
  args.push("--allowedTools", ["Read", "Grep", "Glob", ...bashRules, "mcp__crit"].join(","));
  args.push("--disallowedTools", DISALLOWED.join(","));
  const model = task.model ?? profile.model;
  if (model) args.push("--model", model);
  return { command: profile.command, args, stdin: task.prompt, files, cleanupDir: dir };
}

type Block = { type: string; text?: string; name?: string; input?: Record<string, unknown> };
type Line =
  | {
      type: "system";
      subtype: string;
      session_id?: string;
      mcp_servers?: { name: string; status: string }[];
    }
  | { type: "assistant"; message: { id?: string; content: Block[]; usage?: ClaudeUsage } }
  | { type: "user" }
  | {
      type: "rate_limit_event";
      rate_limit_info?: { status?: string; resetsAt?: number };
    }
  | {
      type: "result";
      subtype: string;
      is_error?: boolean;
      result?: string;
      usage?: ClaudeUsage;
    };

type ClaudeUsage = {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
};

/** Fresh input includes cache writes (billed above normal input); cache reads are the cached part. */
const claudeUsage = (u: ClaudeUsage) => ({
  inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
  outputTokens: u.output_tokens ?? 0,
  cachedInputTokens: u.cache_read_input_tokens ?? 0,
});

const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function describeTool(b: Block): string | undefined {
  const i = b.input ?? {};
  switch (b.name) {
    case "Read":
      return typeof i.file_path === "string" ? `reading ${basename(i.file_path)}` : undefined;
    case "Grep":
      return typeof i.pattern === "string"
        ? `searching ${short(JSON.stringify(i.pattern), 40)}`
        : undefined;
    case "Glob":
      return typeof i.pattern === "string" ? `listing ${i.pattern}` : undefined;
    case "Bash":
      return typeof i.command === "string" ? `running ${short(i.command, 60)}` : undefined;
    default:
      return undefined;
  }
}

const USAGE_LIMIT = /usage limit|rate limit|limit reached|too many requests|overloaded/i;
const NOT_LOGGED_IN =
  /not logged in|please run \/login|invalid api key|authentication|unauthorized|oauth/i;

/** Turn Claude Code stream-json lines into AgentEvents. Stateful per run. */
export class ClaudeStreamParser {
  private gotResult = false;
  private readonly perMessage = new Map<string, ReturnType<typeof claudeUsage>>();
  readonly stderr: string[] = [];

  private readonly loginHint: string;
  constructor(loginHint: string) {
    this.loginHint = loginHint;
  }

  line(raw: string): AgentEvent[] {
    let d: Line;
    try {
      d = JSON.parse(raw) as Line;
    } catch {
      return [];
    }
    const out: AgentEvent[] = [];
    switch (d.type) {
      case "system":
        if (d.subtype === "init") {
          if (d.session_id) out.push({ type: "session", id: d.session_id });
          const crit = d.mcp_servers?.find((s) => s.name === "crit");
          if (crit && crit.status !== "connected") {
            out.push({
              type: "error",
              message: `crit MCP server did not start (status: ${crit.status})`,
            });
          }
        }
        break;
      case "assistant":
        // Each content block of one API call arrives as its own line with the same
        // usage; keep the latest per message id and report the running total.
        if (d.message?.usage) {
          this.perMessage.set(
            d.message.id ?? `m${this.perMessage.size}`,
            claudeUsage(d.message.usage),
          );
          const total = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
          for (const m of this.perMessage.values()) {
            total.inputTokens += m.inputTokens;
            total.outputTokens += m.outputTokens;
            total.cachedInputTokens += m.cachedInputTokens;
          }
          out.push({ type: "usage", partial: true, ...total });
        }
        for (const b of d.message?.content ?? []) {
          if (b.type === "tool_use" && b.name) {
            out.push({ type: "tool", name: b.name });
            const text = describeTool(b);
            if (text) out.push({ type: "progress", text });
          } else if (b.type === "text" && b.text?.trim()) {
            out.push({ type: "progress", text: short(b.text.trim().split("\n")[0]!) });
          }
        }
        break;
      case "rate_limit_event": {
        const info = d.rate_limit_info;
        if (info?.status === "rejected") {
          const e: AgentEvent = { type: "rate-limited" };
          if (info.resetsAt) e.retryAfterMs = Math.max(0, info.resetsAt * 1000 - Date.now());
          out.push(e);
        }
        break;
      }
      case "result": {
        this.gotResult = true;
        const u = d.usage;
        if (u) {
          out.push({ type: "usage", ...claudeUsage(u) });
        }
        if (d.is_error || d.subtype !== "success") {
          const msg = d.result ?? d.subtype;
          if (USAGE_LIMIT.test(msg)) out.push({ type: "rate-limited" });
          else if (NOT_LOGGED_IN.test(msg))
            out.push({ type: "error", message: `${msg} (${this.loginHint})` });
          else out.push({ type: "error", message: `claude: ${msg}` });
        } else if (d.result !== undefined) {
          out.push({ type: "message", text: d.result });
        }
        break;
      }
    }
    return out;
  }

  /** Events for the process exit. */
  exit(code: number, timedOut: boolean): AgentEvent[] {
    const out: AgentEvent[] = [];
    if (timedOut) out.push({ type: "error", message: "claude timed out" });
    else if (!this.gotResult) {
      const tail = this.stderr.slice(-5).join("\n").trim();
      if (NOT_LOGGED_IN.test(tail))
        out.push({ type: "error", message: `${tail} (${this.loginHint})` });
      else if (USAGE_LIMIT.test(tail)) out.push({ type: "rate-limited" });
      else
        out.push({
          type: "error",
          message: `claude exited with code ${code}${tail ? `: ${tail}` : ""}`,
        });
    }
    out.push({ type: "done", exitCode: timedOut ? 124 : code });
    return out;
  }
}

export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly type = "claude-code";
  readonly capabilities = {
    mcp: true,
    jsonSchemaOutput: false,
    readOnlyMode: true,
    nativeContext: [],
    models: ["opus", "sonnet", "haiku"],
  };

  private readonly profile: ProviderProfile;
  private readonly env: AdapterEnv;
  constructor(profile: ProviderProfile, env: AdapterEnv) {
    this.profile = profile;
    this.env = env;
  }

  detect() {
    return detectCli(this.profile.command, this.env.env, CLAUDE_TESTED);
  }

  async *run(task: AgentTask, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const inv = buildClaudeInvocation(this.profile, task, this.env.tmpDir);
    mkdirSync(inv.cleanupDir, { recursive: true });
    for (const f of inv.files) writeFileSync(f.path, f.content);
    const parser = new ClaudeStreamParser(claudeCodeFactory.loginHint);
    try {
      for await (const e of streamProcess({
        command: inv.command,
        args: inv.args,
        cwd: task.cwd,
        env: this.env.env,
        stdin: inv.stdin,
        signal,
        timeoutMs: task.timeoutMs,
      })) {
        if (e.kind === "stdout") yield* parser.line(e.line);
        else if (e.kind === "stderr") parser.stderr.push(e.line);
        else yield* parser.exit(e.code, e.timedOut);
      }
    } finally {
      rmSync(inv.cleanupDir, { recursive: true, force: true });
    }
  }
}

export const claudeCodeFactory: AdapterFactory = {
  type: "claude-code",
  label: "Claude Code",
  defaultCommand: "claude",
  defaultName: "claude",
  loginHint: "run `claude` once to log in",
  models: ["opus", "sonnet", "haiku"],
  create: (profile, env) => new ClaudeCodeAdapter(profile, env),
};
