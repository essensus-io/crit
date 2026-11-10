import { undoApply } from "@crit/core";
import { shortId } from "@crit/schema";
import { listHistory } from "@crit/store";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { CliError, EXIT } from "@/shared/lib/errors.ts";
import { plural } from "@/shared/lib/format.ts";
import { repoRootOrThrow } from "@/shared/lib/repo-root-or-throw.ts";

export async function undoCommand(ctx: CliContext, args: { force?: boolean }): Promise<number> {
  const root = await repoRootOrThrow(ctx.cwd);
  const store = ctx.openStore();
  const repo = await store.repos.getByRoot(root);
  if (!repo) throw new CliError("crit: nothing to undo in this repository");
  const ids = (await listHistory(store.db, { repoId: repo.id, limit: 50 })).map(
    (historyRow) => historyRow.review.id,
  );
  try {
    const undoResult = await undoApply({ store, reviewIds: ids, root, force: Boolean(args.force) });
    if (undoResult.branchDeleted) ctx.out(`Deleted branch ${undoResult.branchDeleted}\n`);
    else
      ctx.out(
        `Restored ${plural(undoResult.restored.length, "file")}${undoResult.removed.length ? `, removed ${plural(undoResult.removed.length, "new file")}` : ""} (review ${shortId(undoResult.reviewId)})\n`,
      );
    return EXIT.ok;
  } catch (err) {
    throw new CliError((err as Error).message);
  }
}
