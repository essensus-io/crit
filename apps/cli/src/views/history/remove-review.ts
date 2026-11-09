import { shortId } from "@crit/schema";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { CliError, EXIT } from "@/shared/lib/errors.ts";
import { resolveReview } from "@/features/review-session/lib/resolve-review.ts";
import { repoRootOrThrow } from "@/shared/lib/repo-root-or-throw.ts";

export async function removeReview(ctx: CliContext, ref: string, yes?: boolean): Promise<number> {
  const store = ctx.openStore();
  const root = await repoRootOrThrow(ctx.cwd);
  const r = await resolveReview(ctx, store, root, ref);
  if (!yes) {
    if (!ctx.interactive)
      throw new CliError(`crit: pass --yes to delete review ${shortId(r.id)}`, {
        exitCode: EXIT.usage,
      });
    if (
      !(await ctx.prompter.confirm({
        message: `Delete review ${shortId(r.id)} (${r.scopeLabel})?`,
        initialValue: false,
      }))
    )
      return EXIT.cancelled;
  }
  await store.reviews.delete(r.id);
  ctx.out(`Deleted review ${shortId(r.id)}\n`);
  return EXIT.ok;
}
