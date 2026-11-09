import { effectiveTokens, type Finding } from "@crit/schema";
import { reportUsage, type ReviewRun } from "./review-run.ts";
import { depthProfile } from "./shards.ts";
import { verify } from "./verify-findings.ts";
import type { ProviderRun } from "./review-types.ts";

export const verifyReviewFindings = async (
  run: ReviewRun,
  findings: Finding[],
): Promise<{ findings: Finding[]; skeptic: ProviderRun | null }> => {
  const { options, prepared } = run;
  const { store, config } = options;
  const mode = depthProfile(config).skeptic;
  const skeptic =
    mode === "off" ? null : options.skeptic === undefined ? options.provider : options.skeptic;
  const toCheck = findings.filter(
    (finding) => finding.verdict === undefined && (mode === "all" || finding.severity !== "nit"),
  );
  if (!skeptic || toCheck.length === 0) return { findings, skeptic };
  if (run.stopReason === "budget") {
    run.emit({ type: "warning", message: "skeptic skipped: token budget reached" });
    return { findings, skeptic };
  }
  run.emit({ type: "verify-started", count: toCheck.length });
  const verdicts = await verify(toCheck, skeptic, prepared.scope, config, run.userSignal, {
    fast: mode !== "all",
    deep: mode === "all",
  });
  run.finishedSpend += effectiveTokens(verdicts.usage);
  reportUsage(run, "skeptic");
  await store.events.append(run.review.id, "usage", { task: "skeptic", ...verdicts.usage });
  for (const message of verdicts.warnings) run.emit({ type: "warning", message });
  for (const finding of toCheck) {
    const result = verdicts.results.get(finding.id);
    if (!result) continue;
    await store.findings.update(finding.id, {
      verdict: result.verdict,
      verdictReason: result.reason,
    });
    run.emit({ type: "verified", result });
  }
  return { findings: await store.findings.listByReview(run.review.id), skeptic };
};
