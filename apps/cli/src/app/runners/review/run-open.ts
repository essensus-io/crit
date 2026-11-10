import { argsFromScope } from "./review-args.ts";
import { resolveConfig } from "@crit/schema";
import { exportReview, loadProjectConfig, loadUserConfig } from "@crit/store";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { EXIT } from "@/shared/lib/errors.ts";
import { textReport } from "@/features/review-report/lib/text-report.ts";
import { resolveReview } from "@/features/review-session/lib/resolve-review.ts";
import { repoRootOrThrow } from "@/shared/lib/repo-root-or-throw.ts";

export async function openCommand(
  ctx: CliContext,
  args: { review?: string; tui?: boolean },
): Promise<number> {
  const root = await repoRootOrThrow(ctx.cwd);
  const store = ctx.openStore();
  const review = await resolveReview(ctx, store, root, args.review);
  if (ctx.interactive && args.tui !== false) {
    const { openTui } = await import("./launch-review.tsx");
    const rerun = await openTui(
      ctx,
      store,
      root,
      review.id,
      resolveConfig(loadUserConfig(ctx.paths), loadProjectConfig(root)),
      { home: true },
    );
    if (!rerun) return EXIT.ok;
    const { runReviewCommand } = await import("./run-review-command.ts");
    if (rerun === "home") return runReviewCommand(ctx, { _: [] });
    return runReviewCommand(ctx, {
      ...argsFromScope(review.scope),
      ...(rerun.provider ? { provider: rerun.provider } : {}),
      ...(rerun.model ? { model: rerun.model } : {}),
      ...(rerun.effort ? { effort: rerun.effort } : {}),
      depth: rerun.depth,
      cache: !rerun.fresh,
    });
  }
  ctx.out(textReport(await exportReview(store, review.id), { color: ctx.color }));
  return EXIT.ok;
}
