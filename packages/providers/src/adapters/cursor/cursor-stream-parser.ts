import { basename } from "node:path";
import type { AgentEvent } from "@crit/schema";

type Line = {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
  message?: { content?: { type: string; text?: string }[] };
  tool_call?: Record<string, { args?: { path?: string; pattern?: string; globPattern?: string } }>;
};

const USAGE_LIMIT = /usage limit|rate limit|too many requests|429|quota/i;
const NOT_LOGGED_IN = /not logged in|log ?in|unauthori[sz]ed|401|api key|authenticat/i;

export const createCursorStreamParser = (loginHint: string) => {
  const stderr: string[] = [];
  let gotResult = false;

  const classify = (msg: string): AgentEvent => {
    if (USAGE_LIMIT.test(msg)) return { type: "rate-limited" };
    if (NOT_LOGGED_IN.test(msg)) return { type: "error", message: `${msg} (${loginHint})` };
    return { type: "error", message: `cursor: ${msg}` };
  };

  const line = (raw: string): AgentEvent[] => {
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
      gotResult = true;
      if (d.usage)
        out.push({
          type: "usage",
          inputTokens: d.usage.inputTokens ?? 0,
          outputTokens: d.usage.outputTokens ?? 0,
          cachedInputTokens: d.usage.cacheReadTokens ?? 0,
        });
      if (d.is_error || d.subtype !== "success")
        out.push(classify(d.result ?? d.subtype ?? "error"));
      else if (d.result !== undefined) out.push({ type: "message", text: d.result });
    }
    return out;
  };

  const exit = (code: number, timedOut: boolean): AgentEvent[] => {
    const out: AgentEvent[] = [];
    if (timedOut) out.push({ type: "error", message: "cursor-agent timed out" });
    else if (!gotResult) {
      const tail = stderr.slice(-5).join("\n").trim();
      out.push(
        tail ? classify(tail) : { type: "error", message: `cursor-agent exited with code ${code}` },
      );
    }
    out.push({ type: "done", exitCode: timedOut ? 124 : code });
    return out;
  };

  return { stderr, line, exit };
};
