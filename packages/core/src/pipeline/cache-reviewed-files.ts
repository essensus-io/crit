import type { Finding } from "@crit/schema";
import { cacheKeyFor } from "./file-cache.ts";
import type { ReviewRun } from "./review-run.ts";
import type { CachedFinding } from "./review-types.ts";

const toCachedFinding = (finding: Finding): CachedFinding => {
  const {
    id: _id,
    reviewId: _reviewId,
    shardId: _shardId,
    fingerprint: _fingerprint,
    status: _status,
    selected: _selected,
    mergedFrom: _mergedFrom,
    groupId: _groupId,
    createdAt: _createdAt,
    dismissReason: _dismissReason,
    ...input
  } = finding;
  return input;
};

export const cacheReviewedFiles = async (run: ReviewRun, findings: Finding[]) => {
  const { options, prepared } = run;
  if (options.useCache === false) return;
  const { store } = options;
  for (const file of run.reviewedFiles) {
    const entries: CachedFinding[] = [];
    for (const finding of findings.filter((candidate) => candidate.file === file)) {
      const fix = await store.fixes.active(finding.id);
      entries.push({
        ...toCachedFinding(finding),
        ...(fix?.author === "ai" ? { fix: { summary: fix.summary, patch: fix.patch } } : {}),
      });
    }
    await store.cache.put({
      key: await cacheKeyFor(prepared, options, file),
      reviewId: run.review.id,
      value: JSON.stringify({ findings: entries }),
      transcriptPath: null,
    });
  }
};
