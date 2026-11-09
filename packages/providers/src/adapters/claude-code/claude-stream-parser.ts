import { basename } from "node:path";
import type { AgentEvent } from "@crit/schema";

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

const claudeUsage = (u: ClaudeUsage) => ({
  inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
  outputTokens: u.output_tokens ?? 0,
  cachedInputTokens: u.cache_read_input_tokens ?? 0,
});

const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function describeTool(block: Block): string | undefined {
  const i = block.input ?? {};
  switch (block.name) {
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

export const createClaudeStreamParser = (loginHint: string) => {
  let gotResult = false;
  const perMessage = new Map<string, ReturnType<typeof claudeUsage>>();
  const stderr: string[] = [];

  const line = (raw: string): AgentEvent[] => {
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
          const crit = d.mcp_servers?.find((mcp_server) => mcp_server.name === "crit");
          if (crit && crit.status !== "connected") {
            out.push({
              type: "error",
              message: `crit MCP server did not start (status: ${crit.status})`,
            });
          }
        }
        break;
      case "assistant":
        if (d.message?.usage) {
          perMessage.set(d.message.id ?? `m${perMessage.size}`, claudeUsage(d.message.usage));
          const total = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
          for (const m of perMessage.values()) {
            total.inputTokens += m.inputTokens;
            total.outputTokens += m.outputTokens;
            total.cachedInputTokens += m.cachedInputTokens;
          }
          out.push({ type: "usage", partial: true, ...total });
        }
        for (const block of d.message?.content ?? []) {
          if (block.type === "tool_use" && block.name) {
            out.push({ type: "tool", name: block.name });
            const text = describeTool(block);
            if (text) out.push({ type: "progress", text });
          } else if (block.type === "text" && block.text?.trim()) {
            out.push({ type: "progress", text: short(block.text.trim().split("\n")[0]!) });
          }
        }
        break;
      case "rate_limit_event": {
        const info = d.rate_limit_info;
        if (info?.status === "rejected") {
          const agentEvent: AgentEvent = { type: "rate-limited" };
          if (info.resetsAt)
            agentEvent.retryAfterMs = Math.max(0, info.resetsAt * 1000 - Date.now());
          out.push(agentEvent);
        }
        break;
      }
      case "result": {
        gotResult = true;
        const u = d.usage;
        if (u) {
          out.push({ type: "usage", ...claudeUsage(u) });
        }
        if (d.is_error || d.subtype !== "success") {
          const msg = d.result ?? d.subtype;
          if (USAGE_LIMIT.test(msg)) out.push({ type: "rate-limited" });
          else if (NOT_LOGGED_IN.test(msg))
            out.push({ type: "error", message: `${msg} (${loginHint})` });
          else out.push({ type: "error", message: `claude: ${msg}` });
        } else if (d.result !== undefined) {
          out.push({ type: "message", text: d.result });
        }
        break;
      }
    }
    return out;
  };

  const exit = (code: number, timedOut: boolean): AgentEvent[] => {
    const out: AgentEvent[] = [];
    if (timedOut) out.push({ type: "error", message: "claude timed out" });
    else if (!gotResult) {
      const tail = stderr.slice(-5).join("\n").trim();
      if (NOT_LOGGED_IN.test(tail)) out.push({ type: "error", message: `${tail} (${loginHint})` });
      else if (USAGE_LIMIT.test(tail)) out.push({ type: "rate-limited" });
      else
        out.push({
          type: "error",
          message: `claude exited with code ${code}${tail ? `: ${tail}` : ""}`,
        });
    }
    out.push({ type: "done", exitCode: timedOut ? 124 : code });
    return out;
  };

  return { stderr, line, exit };
};
