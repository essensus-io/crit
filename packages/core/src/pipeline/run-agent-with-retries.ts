import { type AgentTask, effectiveTokens, type Shard } from "@crit/schema";
import { type AgentOutcome, runAgent } from "./agent.ts";
import { checkBudget, reportUsage, type ReviewRun } from "./review-run.ts";
import { sleep } from "./sleep.ts";

const MAX_ATTEMPTS = 3;
const DEFAULT_RATE_LIMIT_WAIT_MS = 5 * 60_000;
const DEFAULT_RETRY_AFTER_MS = 30_000;

export const runAgentWithRetries = async (
  run: ReviewRun,
  shard: Shard,
  task: AgentTask,
): Promise<AgentOutcome | undefined> => {
  const maxWait = run.options.maxRateLimitWaitMs ?? DEFAULT_RATE_LIMIT_WAIT_MS;
  let outcome: AgentOutcome | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    outcome = await runAgent(run.options.provider.adapter, task, run.signal, (event) => {
      if (event.type === "progress")
        run.emit({ type: "shard-progress", shardId: shard.id, text: event.text });
      if (event.type === "usage") {
        run.liveSpend.set(shard.id, effectiveTokens(event));
        reportUsage(run, "review");
        if (event.partial) checkBudget(run);
      }
    });
    if (!outcome.rateLimited || run.signal.aborted) break;
    const wait = Math.min(outcome.rateLimited.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS, maxWait);
    run.emit({ type: "rate-limited", shardId: shard.id, retryAfterMs: wait });
    if (attempt === MAX_ATTEMPTS - 1 || (outcome.rateLimited.retryAfterMs ?? 0) > maxWait) break;
    await sleep(wait, run.signal);
  }
  return outcome;
};
