import type { Finding } from "@crit/schema";
import type { ReviewRun } from "./review-run.ts";
import type { ProviderRun } from "./review-types.ts";

const MIN_UNVERIFIED_CONFIDENCE = 0.7;

export const selectDefaultChecks = async (
  run: ReviewRun,
  findings: Finding[],
  skeptic: ProviderRun | null,
): Promise<Finding[]> => {
  const { store } = run.options;
  for (const finding of findings) {
    const hasFix = (await store.fixes.active(finding.id)) !== undefined;
    const selected =
      hasFix &&
      (finding.verdict === "confirmed" ||
        (finding.verdict === undefined &&
          !skeptic &&
          finding.confidence >= MIN_UNVERIFIED_CONFIDENCE));
    if (selected !== finding.selected) await store.findings.update(finding.id, { selected });
  }
  return store.findings.listByReview(run.review.id);
};
