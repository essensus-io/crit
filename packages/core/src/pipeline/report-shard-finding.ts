import type { FindingInput } from "@crit/schema";
import type { Intake } from "./intake.ts";
import { persistFinding } from "./persist-finding.ts";
import type { ReviewRun } from "./review-run.ts";
import type { Shard } from "@crit/schema";

export type ShardState = {
  accepted: FindingInput[];
  toolCalls: number;
  summary: string | null;
};

export type ShardReport = (
  raw: FindingInput,
  allowRetry: boolean,
) => Promise<
  { accepted: false; errors: string[] } | { accepted: true; id: string; warnings?: string[] }
>;

export const reportShardFinding = async (
  run: ReviewRun,
  shard: Shard,
  intake: Intake,
  state: ShardState,
  raw: FindingInput,
  allowRetry: boolean,
) => {
  const { store } = run.options;
  const checked = await intake.check(raw, { allowRetry });
  if (!checked.accepted) {
    run.emit({ type: "finding-rejected", shardId: shard.id, errors: checked.errors });
    run.rejectedFiles.add(raw.file);
    await store.events.append(run.review.id, "rejected", {
      file: raw.file,
      title: raw.title,
      errors: checked.errors,
    });
    return { accepted: false as const, errors: checked.errors };
  }
  state.accepted.push(checked.finding);
  if (checked.dropped)
    await store.events.append(run.review.id, "hidden", {
      file: checked.finding.file,
      title: checked.finding.title,
      why: checked.dropped,
    });
  const saved = await persistFinding(run, shard.id, checked);
  return {
    accepted: true as const,
    id: saved?.id ?? "suppressed",
    ...(checked.warnings.length ? { warnings: checked.warnings } : {}),
  };
};
