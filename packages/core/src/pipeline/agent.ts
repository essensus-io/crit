import type { AgentEvent, AgentTask } from "@crit/schema";

/** What core needs from an adapter: the ProviderAdapter contract, structurally. */
export interface AgentRunner {
  readonly capabilities: { mcp: boolean; nativeContext: import("@crit/schema").RuleSourceKind[] };
  run(task: AgentTask, signal: AbortSignal): AsyncIterable<AgentEvent>;
}

export type AgentOutcome = {
  /** Final assistant message, if any. */
  message?: string;
  exitCode: number;
  errors: string[];
  rateLimited?: { retryAfterMs?: number };
  inputTokens: number;
  outputTokens: number;
  sessionId?: string;
  ok: boolean;
};

/** Drive one agent run to completion, forwarding progress. */
export async function runAgent(
  agent: AgentRunner,
  task: AgentTask,
  signal: AbortSignal,
  onEvent?: (e: AgentEvent) => void,
): Promise<AgentOutcome> {
  const out: AgentOutcome = { exitCode: 1, errors: [], inputTokens: 0, outputTokens: 0, ok: false };
  try {
    for await (const e of agent.run(task, signal)) {
      onEvent?.(e);
      switch (e.type) {
        case "message":
          out.message = e.text;
          break;
        case "usage":
          out.inputTokens += e.inputTokens ?? 0;
          out.outputTokens += e.outputTokens ?? 0;
          break;
        case "rate-limited":
          out.rateLimited = e.retryAfterMs === undefined ? {} : { retryAfterMs: e.retryAfterMs };
          break;
        case "session":
          out.sessionId = e.id;
          break;
        case "error":
          out.errors.push(e.message);
          break;
        case "done":
          out.exitCode = e.exitCode;
          break;
      }
    }
  } catch (err) {
    out.errors.push((err as Error).message);
  }
  out.ok = out.exitCode === 0 && out.errors.length === 0 && !out.rateLimited;
  return out;
}
