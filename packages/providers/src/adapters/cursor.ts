import { basename } from "node:path";
import type { AgentEvent, AgentTask, ProviderProfile } from "@crit/schema";
import type { AdapterEnv, AdapterFactory, ProviderAdapter } from "../adapter.ts";
import { detectCli } from "../detect.ts";
import { streamProcess } from "../process.ts";

export const CURSOR_TESTED = { min: "2026.10.0", max: "2026.12.999" };

/**
 * What the T10 spike found (cursor-agent 2026.10.22):
 * - `-p` alone has write and shell access; `--mode ask` is read-only (it
 *   refused to create files or run shell commands in a probe), so there is no
 *   shell and no git in Cursor reviews.
 * - MCP servers load only from .cursor/mcp.json or ~/.cursor/mcp.json; there
 *   is no per-run flag. crit does not write into those files, so Cursor uses
 *   the JSON fallback: the reply is a JSON object checked against the finding
 *   schema, with one repair round.
 * - Cursor loads .cursor/rules, AGENTS.md and CLAUDE.md by itself (verified),
 *   so crit sends those as an index only.
 */
export function buildCursorInvocation(
  profile: Pick<ProviderProfile, "command" | "model">,
  task: AgentTask,
) {
  const args = [
    "-p",
    "--mode",
    "ask",
    "--output-format",
    "stream-json",
    "--trust",
    "--sandbox",
    "enabled",
    "--workspace",
    task.cwd,
  ];
  const model = task.model ?? profile.model;
  if (model) args.push("--model", model);
  const prompt = task.systemPrompt ? `${task.systemPrompt}\n\n---\n\n${task.prompt}` : task.prompt;
  return { command: profile.command, args, stdin: prompt };
}

type Line = {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  message?: { content?: { type: string; text?: string }[] };
  tool_call?: Record<string, { args?: { path?: string; pattern?: string; globPattern?: string } }>;
};

const USAGE_LIMIT = /usage limit|rate limit|too many requests|429|quota/i;
const NOT_LOGGED_IN = /not logged in|log ?in|unauthori[sz]ed|401|api key|authenticat/i;

/** Turn cursor-agent stream-json lines into AgentEvents. */
export class CursorStreamParser {
  readonly stderr: string[] = [];
  private gotResult = false;
  private readonly loginHint: string;

  constructor(loginHint: string) {
    this.loginHint = loginHint;
  }

  private classify(msg: string): AgentEvent {
    if (USAGE_LIMIT.test(msg)) return { type: "rate-limited" };
    if (NOT_LOGGED_IN.test(msg)) return { type: "error", message: `${msg} (${this.loginHint})` };
    return { type: "error", message: `cursor: ${msg}` };
  }

  line(raw: string): AgentEvent[] {
    let d: Line;
    try {
      d = JSON.parse(raw) as Line;
    } catch {
      return [];
    }
    const out: AgentEvent[] = [];
    if (d.type === "system" && d.subtype === "init" && d.session_id)
      out.push({ type: "session", id: d.session_id });
    else if (d.type === "tool_call" && d.subtype === "started" && d.tool_call) {
      const [key, call] = Object.entries(d.tool_call).find(([k]) => k.endsWith("ToolCall")) ?? [];
      if (key) {
        const name = key.replace(/ToolCall$/, "");
        out.push({ type: "tool", name });
        const target = call?.args?.path
          ? `reading ${basename(call.args.path)}`
          : call?.args?.pattern
            ? `searching ${call.args.pattern}`
            : call?.args?.globPattern
              ? `listing ${call.args.globPattern}`
              : undefined;
        if (target) out.push({ type: "progress", text: target });
      }
    } else if (d.type === "assistant") {
      const text = d.message?.content
        ?.map((c) => c.text ?? "")
        .join("")
        .trim();
      if (text) out.push({ type: "progress", text: text.split("\n")[0]!.slice(0, 80) });
    } else if (d.type === "result") {
      this.gotResult = true;
      if (d.is_error || d.subtype !== "success")
        out.push(this.classify(d.result ?? d.subtype ?? "error"));
      else if (d.result !== undefined) out.push({ type: "message", text: d.result });
    }
    return out;
  }

  exit(code: number, timedOut: boolean): AgentEvent[] {
    const out: AgentEvent[] = [];
    if (timedOut) out.push({ type: "error", message: "cursor-agent timed out" });
    else if (!this.gotResult) {
      const tail = this.stderr.slice(-5).join("\n").trim();
      out.push(
        tail
          ? this.classify(tail)
          : { type: "error", message: `cursor-agent exited with code ${code}` },
      );
    }
    out.push({ type: "done", exitCode: timedOut ? 124 : code });
    return out;
  }
}

export class CursorAdapter implements ProviderAdapter {
  readonly type = "cursor";
  readonly capabilities = {
    mcp: false,
    jsonSchemaOutput: false,
    readOnlyMode: true,
    nativeContext: [
      "cursor-rule" as const,
      "cursorrules" as const,
      "agents-md" as const,
      "claude-md" as const,
    ],
    models: [],
  };
  private readonly profile: ProviderProfile;
  private readonly env: AdapterEnv;

  constructor(profile: ProviderProfile, env: AdapterEnv) {
    this.profile = profile;
    this.env = env;
  }

  detect() {
    return detectCli(this.profile.command, this.env.env, CURSOR_TESTED);
  }

  async *run(task: AgentTask, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const inv = buildCursorInvocation(this.profile, task);
    const parser = new CursorStreamParser(cursorFactory.loginHint);
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
  }
}

export const cursorFactory: AdapterFactory = {
  type: "cursor",
  label: "Cursor",
  defaultCommand: "cursor-agent",
  defaultName: "cursor",
  loginHint: "run `cursor-agent login`",
  models: [],
  create: (profile, env) => new CursorAdapter(profile, env),
};
