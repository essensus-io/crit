import { newId, type Review } from "@crit/schema";
import { depthProfile } from "./shards.ts";
import type { Prepared, ReviewOptions } from "./review-types.ts";
import type { ReviewEvent } from "@crit/schema";

type RuleSummary = { id: string; title: string; path: string; section?: string | undefined };

const summarize = ({ id, title, path, section }: RuleSummary) => ({
  id,
  title,
  path,
  ...(section ? { section } : {}),
});

export const startReview = async (
  options: ReviewOptions,
  prepared: Prepared,
  now: () => number,
  emit: (event: ReviewEvent) => void,
  startedAt: number,
): Promise<Review> => {
  const { store, config } = options;
  const { scope, repo, rules } = prepared;
  const review = await store.reviews.create({
    id: newId(now()),
    repoId: repo.id,
    scope: options.spec,
    scopeLabel: scope.label,
    branch: scope.branch ?? null,
    baseSha: scope.baseSha ?? null,
    headSha: scope.headSha ?? null,
    provider: options.provider.profile.name,
    model: options.provider.profile.model,
    lenses: depthProfile(config).lenses,
    status: "running",
    supersededBy: null,
    summary: null,
    rulesHeader: [...rules.attached, ...rules.native].map((rule) => rule.id).join(","),
    startedAt,
    finishedAt: null,
  });
  emit({
    type: "review-started",
    reviewId: review.id,
    scope,
    provider: review.provider,
    model: review.model,
  });
  await store.events.append(review.id, "rules", {
    rules: [...rules.attached, ...rules.listed, ...rules.native, ...rules.skills].map(summarize),
    conflicts: rules.conflicts,
  });
  emit({
    type: "rules",
    attached: rules.attached.map(summarize),
    listed: [...rules.listed, ...rules.native, ...rules.skills].map(({ id, title, path }) => ({
      id,
      title,
      path,
    })),
    conflicts: rules.conflicts.map(({ topic, ruleIds }) => ({ topic, ruleIds })),
  });
  for (const message of rules.errors) emit({ type: "warning", message });
  return review;
};
