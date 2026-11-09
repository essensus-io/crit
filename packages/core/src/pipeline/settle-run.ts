import type { Shard } from "@crit/schema";
import type { ReviewRun } from "./review-run.ts";

export type Settlement = {
  status: "completed" | "partial";
  summary: string | null;
  partial?: string;
};

const stoppedMessage = (run: ReviewRun, ran: number, total: number) =>
  run.stopReason === "budget"
    ? `Stopped at the ${run.options.config.budget.maxTokens.toLocaleString("en-US")}-token budget after ${ran} of ${total} runs. Findings so far are kept; run again to resume (finished files are cached), or raise the budget with --budget.`
    : `Stopped early because the provider is rate limited, after ${ran} of ${total} runs. Findings so far are kept; run again later to resume (finished files are cached).`;

const emptyScopeSummary = (run: ReviewRun) =>
  run.prepared.cached.size > 0
    ? `All ${run.prepared.cached.size} files are unchanged since their last review; results come from the cache.`
    : "Nothing to review in this scope.";

export const settleRun = (run: ReviewRun, shards: Shard[], done: Shard[]): Settlement => {
  const failedShards = done.filter((shard) => shard.status === "failed");
  if (failedShards.length === done.length && done.length > 0 && !run.stopReason) {
    throw new Error(
      `crit: every shard failed: ${failedShards
        .map((shard) => shard.error)
        .filter(Boolean)
        .join("; ")}`,
    );
  }
  for (const shard of failedShards)
    run.emit({ type: "warning", message: `shard ${shard.label} failed: ${shard.error}` });
  const ran = done.filter((shard) => shard.status === "done").length;
  const partial =
    run.stopReason && ran < shards.length ? stoppedMessage(run, ran, shards.length) : undefined;
  if (partial) return { status: "partial", summary: partial, partial };
  const summaries = done
    .map((shard) => shard.summary)
    .filter((summary): summary is string => Boolean(summary));
  const summary = summaries.join("\n\n") || (shards.length === 0 ? emptyScopeSummary(run) : null);
  return { status: "completed", summary };
};
