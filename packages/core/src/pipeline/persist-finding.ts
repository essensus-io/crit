import { type Finding, type Fix, newId } from "@crit/schema";
import type { Intake } from "./intake.ts";
import type { ReviewRun } from "./review-run.ts";

export type AcceptedFinding = Extract<Awaited<ReturnType<Intake["check"]>>, { accepted: true }>;

export const persistFinding = async (
  run: ReviewRun,
  shardId: string | undefined,
  accepted: AcceptedFinding,
): Promise<Finding | undefined> => {
  if (accepted.dropped) return undefined;
  const { store } = run.options;
  const { fix, ...rest } = accepted.finding;
  const finding: Finding = {
    ...rest,
    id: newId(run.now()),
    reviewId: run.review.id,
    ...(shardId ? { shardId } : {}),
    fingerprint: accepted.fingerprint,
    status: "open",
    selected: false,
    mergedFrom: [],
    createdAt: run.now(),
  };
  await store.findings.create(finding);
  if (fix) {
    const aiFix: Fix = {
      id: newId(run.now()),
      findingId: finding.id,
      author: "ai",
      patch: fix.patch,
      summary: fix.summary,
      overridden: false,
      active: true,
      createdAt: run.now(),
    };
    await store.fixes.create(aiFix);
  }
  run.emit({ type: "finding", finding });
  return finding;
};
