import { addUsage, type AgentEvent, type AgentTask, emptyUsage } from "@crit/schema";

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
  /** Fresh (uncached) input tokens. */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
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
  const out: AgentOutcome = {
    exitCode: 1,
    errors: [],
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    ok: false,
  };
  // A run reports cumulative partial usage while it works and final usage at the end; final wins.
  let running = emptyUsage();
  let final: ReturnType<typeof emptyUsage> | undefined;
  try {
    for await (const e of agent.run(task, signal)) {
      onEvent?.(e);
      switch (e.type) {
        case "message":
          out.message = e.text;
          break;
        case "usage":
          if (e.partial) running = { ...emptyUsage(), ...stripUndefined(e) };
          else final = addUsage(final ?? emptyUsage(), e);
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
  const total = final ?? running;
  out.inputTokens = total.inputTokens;
  out.outputTokens = total.outputTokens;
  out.cachedInputTokens = total.cachedInputTokens;
  out.ok = out.exitCode === 0 && out.errors.length === 0 && !out.rateLimited;
  return out;
}

const stripUndefined = (e: {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}) => ({
  inputTokens: e.inputTokens ?? 0,
  outputTokens: e.outputTokens ?? 0,
  cachedInputTokens: e.cachedInputTokens ?? 0,
});
