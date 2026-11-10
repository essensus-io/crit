import type { CliContext } from "@/shared/lib/cli-context.ts";
import { CliError, EXIT } from "@/shared/lib/errors.ts";
import { resolveReview } from "@/features/review-session/lib/resolve-review.ts";
import { repoRootOrThrow } from "@/shared/lib/repo-root-or-throw.ts";
import { type HistoryArgs, historyRows } from "@/features/review-history/lib/history-rows.ts";
import { compareReviews } from "@/features/review-history/lib/compare-reviews.ts";
import { outcomeOf } from "@/features/review-history/lib/history-labels.ts";
import { renderComparison } from "@/features/review-history/lib/render-comparison.ts";
import { renderHistory } from "@/features/review-history/lib/render-history.ts";

export async function historyCommand(
  ctx: CliContext,
  args: HistoryArgs & { compare?: boolean; list?: boolean; _?: string[]; tui?: boolean },
): Promise<number> {
  const store = ctx.openStore();
  if (args.compare) {
    const [a, b] = args._ ?? [];
    if (!a || !b)
      throw new CliError("crit: --compare takes two review ids", {
        exitCode: EXIT.usage,
        hint: "crit history --compare 9c2e a41f",
      });
    const root = await repoRootOrThrow(ctx.cwd);
    const ra = await resolveReview(ctx, store, root, a);
    const rb = await resolveReview(ctx, store, root, b);
    const cmp = await compareReviews(store, ra, rb);
    if (args.json)
      ctx.out(
        `${JSON.stringify({ older: cmp.older.id, newer: cmp.newer.id, fixed: cmp.fixed, new: cmp.new, stillOpen: cmp.stillOpen }, null, 2)}\n`,
      );
    else ctx.out(renderComparison(cmp, { color: ctx.color, full: Boolean(args.list) }));
    return EXIT.ok;
  }
  const rows = await historyRows(ctx, store, args);
  if (args.json) {
    ctx.out(
      `${JSON.stringify(
        rows.map((historyRow) => ({ ...historyRow, outcomeLabel: outcomeOf(historyRow) })),
        null,
        2,
      )}\n`,
    );
    return EXIT.ok;
  }
  if (rows.length === 0) {
    ctx.out("No reviews yet. Run `crit review`.\n");
    return EXIT.ok;
  }
  if (ctx.interactive && args.tui !== false) {
    const { historyTui } = await import("./launch-history.tsx");
    await historyTui(ctx, store, rows, args);
    return EXIT.ok;
  }
  ctx.out(
    `\n${renderHistory(rows, { now: ctx.now(), color: ctx.color, allRepos: Boolean(args["all-repos"]) })}`,
  );
  return EXIT.ok;
}
