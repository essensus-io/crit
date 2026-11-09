import { listHistory } from "@crit/store";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { CliError, EXIT } from "@/shared/lib/errors.ts";
import { plural } from "@/shared/lib/format.ts";
import { repoRootOrThrow } from "@/shared/lib/repo-root-or-throw.ts";
import { parseAge } from "@/features/review-history/lib/parse-age.ts";

export async function pruneReviews(
  ctx: CliContext,
  args: { "older-than"?: string; "all-repos"?: boolean; yes?: boolean },
): Promise<number> {
  if (!args["older-than"])
    throw new CliError("crit: pass --older-than, e.g. 90d", { exitCode: EXIT.usage });
  const before = ctx.now() - parseAge(args["older-than"]);
  const store = ctx.openStore();
  let repoId: string | undefined;
  if (!args["all-repos"]) {
    const root = await repoRootOrThrow(ctx.cwd);
    repoId = (await store.repos.getByRoot(root))?.id;
    if (!repoId) {
      ctx.out("Nothing to prune.\n");
      return EXIT.ok;
    }
  }
  const candidates = (
    await listHistory(store.db, {
      ...(repoId ? { repoId } : {}),
      until: before - 1,
      limit: 100_000,
    })
  ).length;
  if (candidates === 0) {
    ctx.out("Nothing to prune.\n");
    return EXIT.ok;
  }
  if (
    !args.yes &&
    ctx.interactive &&
    !(await ctx.prompter.confirm({
      message: `Delete ${plural(candidates, "review")} older than ${args["older-than"]}?`,
      initialValue: false,
    }))
  )
    return EXIT.cancelled;
  if (!args.yes && !ctx.interactive)
    throw new CliError(`crit: pass --yes to delete ${plural(candidates, "review")}`, {
      exitCode: EXIT.usage,
    });
  const deleted = await store.reviews.deleteOlderThan(before, repoId);
  ctx.out(`Deleted ${plural(deleted.length, "review")} older than ${args["older-than"]}\n`);
  return EXIT.ok;
}
