import { type Review, type Shard } from "@crit/schema";
import { cacheReviewedFiles } from "./cache-reviewed-files.ts";
import { CancelledError } from "./cancelled-error.ts";
import { createIntake } from "./intake.ts";
import { mapRepository } from "./map-repository.ts";
import { mergeReviewFindings } from "./merge-review-findings.ts";
import { planShards } from "./plan-shards.ts";
import { prepareReview } from "./prepare-review.ts";
import { replayCachedFindings } from "./replay-cached-findings.ts";
import type { ReviewRun } from "./review-run.ts";
import type { ReviewOptions, ReviewResult } from "./review-types.ts";
import { runShard } from "./run-shard.ts";
import { selectDefaultChecks } from "./select-default-checks.ts";
import { settleRun } from "./settle-run.ts";
import { estimateDurationMs } from "./shards.ts";
import { startReview } from "./start-review.ts";
import { verifyReviewFindings } from "./verify-review-findings.ts";

const finishReview = async (run: ReviewRun, status: Review["status"], summary: string | null) => {
  const { store } = run.options;
  run.review = await store.reviews.update(run.review.id, {
    status,
    summary,
    finishedAt: run.now(),
  });
  if (status === "completed") await store.reviews.markSuperseded(run.review);
  return run.review;
};

const runShards = async (run: ReviewRun, shards: Shard[]): Promise<Shard[]> => {
  const done: Shard[] = [];
  const queue = [...shards];
  const workers = Math.min(run.options.config.concurrency, queue.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (queue.length && !run.stopReason && !run.signal.aborted) {
        const shard = queue.shift()!;
        const finished = await runShard(run, shard);
        done.push(finished);
        run.emit({ type: "shard-done", shard: finished });
      }
    }),
  );
  return done;
};

export const runReview = async (options: ReviewOptions): Promise<ReviewResult> => {
  const now = options.now ?? Date.now;
  const userSignal = options.signal ?? new AbortController().signal;
  const emit: ReviewRun["emit"] = (event) => options.onEvent?.(event);
  const { store, config } = options;
  const started = now();

  const prepared = await prepareReview(options);
  const { scope, repo, rules, ruleById } = prepared;
  const review = await startReview(options, prepared, now, emit, started);

  const stop = new AbortController();
  const suppressed = new Set(
    (await store.suppressions.list(repo.id)).map((suppression) => suppression.fingerprint),
  );
  const run: ReviewRun = {
    options,
    prepared,
    now,
    emit,
    userSignal,
    signal: AbortSignal.any([userSignal, stop.signal]),
    stop,
    review,
    stopReason: undefined,
    finishedSpend: 0,
    liveSpend: new Map(),
    lastReportedSpend: -1,
    reviewedFiles: new Set(),
    rejectedFiles: new Set(),
    baseIntake: createIntake({
      scope,
      ruleIds: new Set(ruleById.keys()),
      suppressed,
      severityThreshold: config.severityThreshold,
    }),
    repoSummary: undefined,
  };

  try {
    const shards = planShards(prepared, run.review.id, now);
    if (shards.length > config.budget.maxShards) {
      emit({ type: "budget-exceeded", required: shards.length, limit: config.budget.maxShards });
      throw new Error(
        `crit: ${shards.length} shards exceed budget.maxShards (${config.budget.maxShards}); narrow the scope or retry with --max-shards ${shards.length}. This is a local budget, independent of your provider.`,
      );
    }
    const estimateMs = estimateDurationMs(shards.length, config.concurrency);
    for (const shard of shards) await store.shards.create(shard);
    emit({ type: "plan", shards, estimateMs });
    const confirmed =
      !options.confirm ||
      (await options.confirm({
        shards,
        estimateMs,
        estimatedTokens: prepared.estimatedTokens,
        cachedFiles: prepared.cached.size,
        scope,
      }));
    if (!confirmed) throw new CancelledError("cancelled before start");

    await replayCachedFindings(run);
    run.repoSummary = await mapRepository(run, shards.length);
    const done = await runShards(run, shards);
    if (userSignal.aborted) throw new CancelledError("cancelled");

    await mergeReviewFindings(run);
    const verified = await verifyReviewFindings(
      run,
      await store.findings.listByReview(run.review.id),
    );
    const findings = await selectDefaultChecks(run, verified.findings, verified.skeptic);
    await cacheReviewedFiles(run, findings);

    const settlement = settleRun(run, shards, done);
    const finished = await finishReview(run, settlement.status, settlement.summary);
    emit({
      type: "review-done",
      reviewId: finished.id,
      findings,
      durationMs: now() - started,
      ...(settlement.partial ? { partial: settlement.partial } : {}),
    });
    return {
      review: finished,
      findings,
      shards: await store.shards.listByReview(finished.id),
      rules,
      scope,
    };
  } catch (error) {
    const cancelled = error instanceof CancelledError || userSignal.aborted;
    const message = (error as Error).message;
    await finishReview(run, cancelled ? "cancelled" : "failed", cancelled ? "Cancelled." : message);
    emit({ type: "review-failed", reviewId: run.review.id, error: message });
    throw error;
  }
};
