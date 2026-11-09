import type { ReviewRun } from "./review-run.ts";
import { mergeFindings } from "./fingerprint.ts";

export const mergeReviewFindings = async (run: ReviewRun) => {
  const { store } = run.options;
  const all = await store.findings.listByReview(run.review.id);
  const merged = mergeFindings(all);
  for (const id of merged.removed) await store.findings.delete(id);
  for (const finding of merged.findings)
    await store.findings.update(finding.id, {
      mergedFrom: finding.mergedFrom,
      ruleIds: finding.ruleIds,
      ...(finding.groupId ? { groupId: finding.groupId } : {}),
    });
};
