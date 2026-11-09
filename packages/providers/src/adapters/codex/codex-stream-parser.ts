import type { AgentEvent } from "@crit/schema";

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

export const createCodexStreamParser = (loginHint: string) => {
  const stderr: string[] = [];
  let lastMessage: string | undefined;
  let sawCompleted = false;
  let failed = false;

  const classify = (msg: string): AgentEvent => {
    if (USAGE_LIMIT.test(msg)) return { type: "rate-limited" };
    if (NOT_LOGGED_IN.test(msg)) return { type: "error", message: `${msg} (${loginHint})` };
    return { type: "error", message: `codex: ${msg}` };
  };

  const line = (raw: string): AgentEvent[] => {
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
          lastMessage = item.text;
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
        sawCompleted = true;
        const u = d.usage;
        if (u)
          out.push({
            type: "usage",
            inputTokens: Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)),
            outputTokens: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0),
            cachedInputTokens: u.cached_input_tokens ?? 0,
          });
        if (lastMessage !== undefined) out.push({ type: "message", text: lastMessage });
        break;
      }
      case "turn.failed":
        failed = true;
        out.push(classify(d.error?.message ?? "turn failed"));
        break;
      case "error":
        failed = true;
        out.push(classify(d.message ?? d.error?.message ?? "unknown error"));
        break;
    }
    return out;
  };

  const exit = (code: number, timedOut: boolean): AgentEvent[] => {
    const out: AgentEvent[] = [];
    if (timedOut) out.push({ type: "error", message: "codex timed out" });
    else if (!sawCompleted && !failed) {
      const tail = stderr.slice(-5).join("\n").trim();
      out.push(
        tail ? classify(tail) : { type: "error", message: `codex exited with code ${code}` },
      );
    }
    out.push({ type: "done", exitCode: timedOut ? 124 : code });
    return out;
  };

  return { stderr, line, exit };
};
