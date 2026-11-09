import { effectiveTokens, type Shard } from "@crit/schema";
import type { AgentOutcome } from "./agent.ts";
import { cacheKeyFor } from "./file-cache.ts";
import type { ShardState } from "./report-shard-finding.ts";
import { checkBudget, reportUsage, type ReviewRun } from "./review-run.ts";

const COST_RATIO_MIN = 0.5;
const COST_RATIO_MAX = 30;

type Failure = { silent: boolean; rateLimited: boolean };

const failureMessage = (run: ReviewRun, outcome: AgentOutcome | undefined, failure: Failure) => {
  if (run.userSignal.aborted) return null;
  if (run.stopReason === "budget" && run.signal.aborted) return "stopped: token budget reached";
  if (failure.silent) return "the agent never called crit's tools";
  if (failure.rateLimited) return "rate limited; re-run to resume";
  return outcome?.errors.join("; ") || `agent exited with code ${outcome?.exitCode}`;
};

const recordFinishedShard = async (
  run: ReviewRun,
  shard: Shard,
  state: ShardState,
  spend: number,
) => {
  const { options, prepared } = run;
  const { store } = options;
  for (const file of shard.files) if (!run.rejectedFiles.has(file)) run.reviewedFiles.add(file);
  if (options.useCache !== false) {
    for (const file of shard.files) {
      if (run.rejectedFiles.has(file)) continue;
      await store.cache.put({
        key: await cacheKeyFor(prepared, options, file),
        reviewId: run.review.id,
        value: JSON.stringify({
          findings: state.accepted.filter((finding) => finding.file === file),
        }),
        transcriptPath: null,
      });
    }
  }
  if (shard.estimatedTokens > 0 && spend > 0) {
    const key = `cost-ratio:${options.provider.profile.type}`;
    const observed = Math.min(
      COST_RATIO_MAX,
      Math.max(COST_RATIO_MIN, spend / shard.estimatedTokens),
    );
    await store.kv.set(
      key,
      String(Math.round((0.5 * prepared.ratio + 0.5 * observed) * 100) / 100),
    );
  }
};

export const finishShard = async (
  run: ReviewRun,
  shard: Shard,
  startedAt: number,
  outcome: AgentOutcome | undefined,
  state: ShardState,
  useMcp: boolean,
): Promise<Shard> => {
  const { store } = run.options;
  const silent = useMcp && !!outcome?.ok && state.toolCalls === 0 && !run.signal.aborted;
  if (silent)
    run.emit({
      type: "warning",
      message: `${shard.label}: the agent finished without calling crit's tools, so nothing was recorded (run crit doctor)`,
    });
  const rateLimited = outcome?.rateLimited !== undefined;
  if (rateLimited && !run.stopReason) run.stopReason = "rate-limit";
  const failed =
    !outcome ||
    run.signal.aborted ||
    silent ||
    rateLimited ||
    outcome.exitCode !== 0 ||
    (outcome.errors.length > 0 && state.accepted.length === 0);
  const status: Shard["status"] = run.signal.aborted ? "cancelled" : failed ? "failed" : "done";
  const spend = outcome ? effectiveTokens(outcome) : 0;
  run.liveSpend.delete(shard.id);
  run.finishedSpend += spend;
  reportUsage(run, "review");
  const updated = await store.shards.update(shard.id, {
    status,
    summary: state.summary,
    inputTokens: outcome?.inputTokens ?? null,
    cachedTokens: outcome?.cachedInputTokens ?? null,
    outputTokens: outcome?.outputTokens ?? null,
    durationMs: run.now() - startedAt,
    agentSessionId: outcome?.sessionId ?? null,
    error: failed ? failureMessage(run, outcome, { silent, rateLimited }) : null,
  });
  if (status === "done") await recordFinishedShard(run, shard, state, spend);
  checkBudget(run);
  return updated;
};
