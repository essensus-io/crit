import { basename } from "node:path";
import { candidateBases, currentBranch, detectBase, type Prepared } from "@crit/core";
import { type ProviderProfile, type ResolvedConfig, type ScopeSpec } from "@crit/schema";
import { listHistory, type SqliteStore } from "@crit/store";
import { type CliContext } from "@/shared/lib/cli-context.ts";
import { EXIT } from "@/shared/lib/errors.ts";
import { plural, when } from "@/shared/lib/format.ts";
import { type ReviewArgs, withoutNow, withScope } from "./review-args.ts";

export async function runHome(
  ctx: CliContext,
  args: ReviewArgs,
  home: {
    root: string;
    store: SqliteStore;
    config: ResolvedConfig;
    profile: ProviderProfile;
    spec: ScopeSpec;
    prepare: (spec: ScopeSpec) => Promise<Prepared>;
  },
  runReviewCommand: (ctx: CliContext, args: ReviewArgs) => Promise<number>,
): Promise<number> {
  const { homeTui } = await import("@/app/runners/home/launch-home.tsx");
  const { openTui } = await import("./launch-review.tsx");
  const { root, store, config, profile } = home;
  const repo = await store.repos.getByRoot(root);
  const history = repo ? await listHistory(store.db, { repoId: repo.id, limit: 12 }) : [];
  const now = ctx.now();
  const branch = await currentBranch(root);
  const base =
    home.spec.kind === "branch" && home.spec.base ? home.spec.base : await detectBase(root);
  const pick = await homeTui(ctx, config, {
    root,
    info: { repo: basename(root), branch, base },
    bases: await candidateBases(root),
    recent: history.map((historyRow) => ({
      id: historyRow.review.id,
      label: historyRow.review.scopeLabel,
      when: when(historyRow.review.startedAt, now),
      findings: plural(
        historyRow.severity.critical +
          historyRow.severity.major +
          historyRow.severity.minor +
          historyRow.severity.nit,
        "finding",
      ),
      outcome:
        historyRow.review.status === "superseded"
          ? "superseded"
          : historyRow.review.status === "partial"
            ? "partial"
            : historyRow.outcome.applied
              ? `${historyRow.outcome.applied} applied`
              : "open",
    })),
    initialSpec: home.spec,
    initialChoice: {
      provider: profile.name,
      model: profile.model,
      effort: profile.effort ?? null,
      depth: config.depth,
    },
    estimate: async (spec) => {
      try {
        const prep = await home.prepare(
          spec.kind === "branch" && !spec.base && base ? { ...spec, base } : spec,
        );
        return {
          ok: true,
          files: prep.scope.files.length,
          skipped: prep.scope.skipped.length,
          runs: prep.runs.length,
          tokens: prep.estimatedTokens,
          cached: prep.cached.size,
        };
      } catch (err) {
        return { ok: false, message: (err as Error).message };
      }
    },
  });
  if (pick.kind === "quit") return EXIT.ok;
  if (pick.kind === "start")
    return runReviewCommand(ctx, {
      ...withScope(args, pick.spec),
      ...(pick.choice?.provider ? { provider: pick.choice.provider } : {}),
      ...(pick.choice
        ? {
            model: pick.choice.model ?? "default",
            effort: pick.choice.effort ?? "default",
            depth: pick.choice.depth,
          }
        : {}),
      now: true,
    });
  const opened = await openTui(ctx, store, root, pick.reviewId, config, { home: true });
  if (opened === "home") return runReviewCommand(ctx, withoutNow(args));
  if (opened) {
    const picked = opened;
    return runReviewCommand(ctx, {
      ...withScope(args, (await store.reviews.get(pick.reviewId))?.scope ?? home.spec),
      ...(picked.provider ? { provider: picked.provider } : {}),
      model: picked.model ?? "default",
      effort: picked.effort ?? "default",
      depth: picked.depth,
      now: true,
    });
  }
  return EXIT.ok;
}
