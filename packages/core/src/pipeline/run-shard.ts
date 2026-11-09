import { startSessionHost } from "@crit/mcp";
import type { Shard } from "@crit/schema";
import { buildReviewTask } from "./build-review-task.ts";
import { finishShard } from "./finish-shard.ts";
import { recoverJsonFindings } from "./recover-json-findings.ts";
import { reportShardFinding, type ShardState } from "./report-shard-finding.ts";
import type { ReviewRun } from "./review-run.ts";
import { runAgentWithRetries } from "./run-agent-with-retries.ts";
import { createShardHandler } from "./shard-handler.ts";

export const runShard = async (run: ReviewRun, shard: Shard): Promise<Shard> => {
  const { store, provider, sessionsDir } = run.options;
  if (run.signal.aborted) return store.shards.update(shard.id, { status: "cancelled" });
  const startedAt = run.now();
  run.emit({ type: "shard-started", shardId: shard.id });
  await store.shards.update(shard.id, { status: "running" });
  const intake = run.baseIntake.restrictTo(shard.files);
  const state: ShardState = { accepted: [], toolCalls: 0, summary: null };
  const report = (raw: Parameters<typeof reportShardFinding>[4], allowRetry: boolean) =>
    reportShardFinding(run, shard, intake, state, raw, allowRetry);
  const handler = createShardHandler(run, shard, report, state);
  const useMcp = provider.adapter.capabilities.mcp;
  const host = useMcp ? await startSessionHost({ handler, dir: sessionsDir }) : undefined;
  const task = await buildReviewTask(run, shard, useMcp, host);
  let outcome = undefined as Awaited<ReturnType<typeof runAgentWithRetries>>;
  try {
    outcome = await runAgentWithRetries(run, shard, task);
    if (!useMcp && outcome && outcome.exitCode === 0 && !outcome.rateLimited)
      outcome = await recoverJsonFindings(run, shard, task, outcome, report, state);
  } finally {
    await host?.close();
  }
  return finishShard(run, shard, startedAt, outcome, state, useMcp);
};
