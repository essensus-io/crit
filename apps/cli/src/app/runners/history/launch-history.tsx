import { makeSession } from "@/app/runners/review/make-session.ts";
import { renderFullScreen } from "@/shared/ui/render-full-screen.tsx";
import { resolveConfig } from "@crit/schema";
import { type HistoryRow, loadProjectConfig, loadUserConfig, type SqliteStore } from "@crit/store";
import { compareReviews } from "@/features/review-history/lib/compare-reviews.ts";
import { type HistoryArgs, historyRows } from "@/features/review-history/lib/history-rows.ts";
import { repoRootOrThrow } from "@/shared/lib/repo-root-or-throw.ts";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { type HistoryActions, HistoryView, previousOf } from "@/views/history/history-view.tsx";

export const historyTui = async (
  ctx: CliContext,
  store: SqliteStore,
  rows: HistoryRow[],
  args: HistoryArgs,
): Promise<void> => {
  const root = await repoRootOrThrow(ctx.cwd);
  const config = resolveConfig(loadUserConfig(ctx.paths), loadProjectConfig(root));
  const actions: HistoryActions = {
    reload: (q) => historyRows(ctx, store, { ...args, ...(q ? { scope: q } : {}) }),
    compare: async (row, all) => {
      const prev = previousOf(row, all);
      return prev ? compareReviews(store, prev.review, row.review) : undefined;
    },
    remove: (row) => store.reviews.delete(row.review.id),
    open: (row) => makeSession(ctx, store, root, row.review.id, config),
  };
  await renderFullScreen(<HistoryView initial={rows} actions={actions} now={ctx.now()} />);
};
