import type { Review, ReviewEvent } from "@crit/schema";
import type { Intake } from "./intake.ts";
import type { Prepared, ReviewOptions } from "./review-types.ts";

export type StopReason = "budget" | "rate-limit";

export type ReviewRun = {
  options: ReviewOptions;
  prepared: Prepared;
  now: () => number;
  emit: (event: ReviewEvent) => void;
  userSignal: AbortSignal;
  signal: AbortSignal;
  stop: AbortController;
  review: Review;
  stopReason: StopReason | undefined;
  finishedSpend: number;
  liveSpend: Map<string, number>;
  lastReportedSpend: number;
  reviewedFiles: Set<string>;
  rejectedFiles: Set<string>;
  baseIntake: Intake;
  repoSummary: string | undefined;
};

export const spentTokens = (run: ReviewRun) =>
  run.finishedSpend + [...run.liveSpend.values()].reduce((total, value) => total + value, 0);

export const reportUsage = (run: ReviewRun, task: "review" | "skeptic" | "map") => {
  const spent = spentTokens(run);
  if (spent === run.lastReportedSpend) return;
  run.lastReportedSpend = spent;
  run.emit({ type: "usage", task, spent, budget: run.options.config.budget.maxTokens });
};

export const checkBudget = (run: ReviewRun) => {
  const maxTokens = run.options.config.budget.maxTokens;
  if (run.stopReason || spentTokens(run) < maxTokens) return;
  run.stopReason = "budget";
  run.emit({ type: "budget-stop", spent: spentTokens(run), limit: maxTokens });
  run.stop.abort();
};
