import { addUsage, type AgentEvent, type AgentTask, emptyUsage } from "@crit/schema";

export type AgentRunner = {
  readonly capabilities: { mcp: boolean; nativeContext: import("@crit/schema").RuleSourceKind[] };
  run(task: AgentTask, signal: AbortSignal): AsyncIterable<AgentEvent>;
};

export type AgentOutcome = {
  message?: string;
  exitCode: number;
  errors: string[];
  rateLimited?: { retryAfterMs?: number };
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  sessionId?: string;
  ok: boolean;
};

export async function runAgent(
  agent: AgentRunner,
  task: AgentTask,
  signal: AbortSignal,
  onEvent?: (agentEvent: AgentEvent) => void,
): Promise<AgentOutcome> {
  const out: AgentOutcome = {
    exitCode: 1,
    errors: [],
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    ok: false,
  };
  let running = emptyUsage();
  let final: ReturnType<typeof emptyUsage> | undefined;
  try {
    for await (const agentEvent of agent.run(task, signal)) {
      onEvent?.(agentEvent);
      switch (agentEvent.type) {
        case "message":
          out.message = agentEvent.text;
          break;
        case "usage":
          if (agentEvent.partial) running = { ...emptyUsage(), ...stripUndefined(agentEvent) };
          else final = addUsage(final ?? emptyUsage(), agentEvent);
          break;
        case "rate-limited":
          out.rateLimited =
            agentEvent.retryAfterMs === undefined ? {} : { retryAfterMs: agentEvent.retryAfterMs };
          break;
        case "session":
          out.sessionId = agentEvent.id;
          break;
        case "error":
          out.errors.push(agentEvent.message);
          break;
        case "done":
          out.exitCode = agentEvent.exitCode;
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
