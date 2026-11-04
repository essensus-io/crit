import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, AgentTask, ProviderProfile } from "@crit/schema";
import type { AdapterEnv, AdapterFactory, ProviderAdapter } from "../adapter.ts";
import { detectCli } from "../detect.ts";
import { streamProcess } from "../process.ts";

export const CODEX_TESTED = { min: "0.160.0", max: "0.199.999" };

/** TOML value for a `-c key=value` override (JSON strings and arrays are valid TOML). */
const toml = (v: string | string[]) => JSON.stringify(v);

export type CodexInvocation = {
  command: string;
  args: string[];
  stdin: string;
  files: { path: string; content: string }[];
  cleanupDir: string;
};

/**
 * `codex exec --json --sandbox read-only`, ephemeral and without the user's
 * config.toml (auth still comes from CODEX_HOME). AGENTS.md loading is turned
 * off (`project_doc_max_bytes=0`) so crit inlines the rules itself. Codex has
 * no system-prompt flag, so crit's instructions lead the stdin prompt.
 */
export function buildCodexInvocation(
  profile: Pick<ProviderProfile, "command" | "model">,
  task: AgentTask,
  tmpDir: string,
): CodexInvocation {
  const dir = join(tmpDir, `codex-${randomBytes(4).toString("hex")}`);
  const files: CodexInvocation["files"] = [];
  const args = [
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--color",
    "never",
    "-C",
    task.cwd,
    "-c",
    'approval_policy="never"',
    "-c",
    "project_doc_max_bytes=0",
  ];
  if (task.mcp && task.mcpSession) {
    // Only crit's own tools are pre-approved; shell commands stay in the read-only sandbox.
    args.push(
      "-c",
      `mcp_servers.crit.command=${toml(task.mcp.command)}`,
      "-c",
      `mcp_servers.crit.args=${toml(task.mcp.args)}`,
      "-c",
      'mcp_servers.crit.default_tools_approval_mode="approve"',
    );
  }
  if (task.outputSchema) {
    const schemaFile = join(dir, "schema.json");
    files.push({ path: schemaFile, content: JSON.stringify(task.outputSchema) });
    args.push("--output-schema", schemaFile);
  }
  const model = task.model ?? profile.model;
  if (model) args.push("-m", model);
  args.push("-");
  const stdin = task.systemPrompt ? `${task.systemPrompt}\n\n---\n\n${task.prompt}` : task.prompt;
  return { command: profile.command, args, stdin, files, cleanupDir: dir };
}

type Item = {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  server?: string;
  tool?: string;
  status?: string;
  error?: { message?: string };
};
type Line = {
  type?: string;
  thread_id?: string;
  item?: Item;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  error?: { message?: string };
  message?: string;
};

const short = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const USAGE_LIMIT = /usage limit|rate limit|too many requests|429|quota/i;
const NOT_LOGGED_IN = /not logged in|login|unauthori[sz]ed|401|api key|authentication/i;

/** Turn `codex exec --json` lines into AgentEvents. Stateful per run. */
export class CodexStreamParser {
  readonly stderr: string[] = [];
  private lastMessage: string | undefined;
  private sawCompleted = false;
  private failed = false;
  private readonly loginHint: string;

  constructor(loginHint: string) {
    this.loginHint = loginHint;
  }

  private classify(msg: string): AgentEvent {
    if (USAGE_LIMIT.test(msg)) return { type: "rate-limited" };
    if (NOT_LOGGED_IN.test(msg)) return { type: "error", message: `${msg} (${this.loginHint})` };
    return { type: "error", message: `codex: ${msg}` };
  }

  line(raw: string): AgentEvent[] {
    let d: Line;
    try {
      d = JSON.parse(raw) as Line;
    } catch {
      return [];
    }
    const out: AgentEvent[] = [];
    const item = d.item;
    switch (d.type) {
      case "thread.started":
        if (d.thread_id) out.push({ type: "session", id: d.thread_id });
        break;
      case "item.started":
        if (item?.type === "command_execution" && item.command) {
          out.push(
            { type: "tool", name: "shell" },
            { type: "progress", text: `running ${short(item.command)}` },
          );
        } else if (item?.type === "mcp_tool_call") {
          out.push({
            type: "tool",
            name: `mcp__${item.server ?? "unknown"}__${item.tool ?? "unknown"}`,
          });
        }
        break;
      case "item.completed":
        if (item?.type === "agent_message" && item.text !== undefined) {
          this.lastMessage = item.text;
          const first = item.text.trim().split("\n")[0];
          if (first) out.push({ type: "progress", text: short(first, 80) });
        } else if (
          item?.type === "mcp_tool_call" &&
          item.status === "failed" &&
          item.error?.message
        ) {
          out.push({ type: "progress", text: `${item.tool} failed: ${short(item.error.message)}` });
        }
        break;
      case "turn.completed": {
        this.sawCompleted = true;
        const u = d.usage;
        if (u)
          out.push({
            type: "usage",
            inputTokens: u.input_tokens ?? 0,
            outputTokens: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0),
          });
        if (this.lastMessage !== undefined) out.push({ type: "message", text: this.lastMessage });
        break;
      }
      case "turn.failed":
        this.failed = true;
        out.push(this.classify(d.error?.message ?? "turn failed"));
        break;
      case "error":
        this.failed = true;
        out.push(this.classify(d.message ?? d.error?.message ?? "unknown error"));
        break;
    }
    return out;
  }

  exit(code: number, timedOut: boolean): AgentEvent[] {
    const out: AgentEvent[] = [];
    if (timedOut) out.push({ type: "error", message: "codex timed out" });
    else if (!this.sawCompleted && !this.failed) {
      const tail = this.stderr.slice(-5).join("\n").trim();
      out.push(
        tail ? this.classify(tail) : { type: "error", message: `codex exited with code ${code}` },
      );
    }
    out.push({ type: "done", exitCode: timedOut ? 124 : code });
    return out;
  }
}

export class CodexAdapter implements ProviderAdapter {
  readonly type = "codex";
  readonly capabilities = {
    mcp: true,
    jsonSchemaOutput: true,
    readOnlyMode: true,
    nativeContext: [],
    models: codexFactoryModels,
  };
  private readonly profile: ProviderProfile;
  private readonly env: AdapterEnv;

  constructor(profile: ProviderProfile, env: AdapterEnv) {
    this.profile = profile;
    this.env = env;
  }

  detect() {
    return detectCli(this.profile.command, this.env.env, CODEX_TESTED);
  }

  async *run(task: AgentTask, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const inv = buildCodexInvocation(this.profile, task, this.env.tmpDir);
    mkdirSync(inv.cleanupDir, { recursive: true });
    for (const f of inv.files) writeFileSync(f.path, f.content);
    const parser = new CodexStreamParser(codexFactory.loginHint);
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

/** No fixed list: Codex model names change often; setup offers the CLI default or a custom name. */
const codexFactoryModels: string[] = [];

export const codexFactory: AdapterFactory = {
  type: "codex",
  label: "Codex",
  defaultCommand: "codex",
  defaultName: "codex",
  loginHint: "run `codex login`",
  models: codexFactoryModels,
  create: (profile, env) => new CodexAdapter(profile, env),
};
