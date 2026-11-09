import { persistFinding } from "./persist-finding.ts";
import type { ReviewRun } from "./review-run.ts";

export const replayCachedFindings = async (run: ReviewRun) => {
  const { store } = run.options;
  let replayed = 0;
  for (const [path, cachedFindings] of run.prepared.cached) {
    const intake = run.baseIntake.restrictTo([path]);
    for (const { verdict, verdictReason, ...finding } of cachedFindings) {
      const checked = await intake.check(finding, { allowRetry: false });
      const saved = checked.accepted ? await persistFinding(run, undefined, checked) : undefined;
      if (!saved) continue;
      replayed++;
      if (verdict)
        await store.findings.update(saved.id, {
          verdict,
          ...(verdictReason ? { verdictReason } : {}),
        });
    }
  }
  if (run.prepared.cached.size > 0)
    run.emit({ type: "cache", files: run.prepared.cached.size, findings: replayed });
};
