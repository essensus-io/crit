import { makeSession } from "@/views/review/make-session.ts";
import { renderFullScreen } from "@/shared/ui/render-full-screen.tsx";
import { resolveConfig } from "@crit/schema";
import { type HistoryRow, loadProjectConfig, loadUserConfig, type SqliteStore } from "@crit/store";
import { compareReviews, type HistoryArgs, historyRows } from "@/commands/history.ts";
import { repoRootOrThrow } from "@/commands/shared.ts";
import type { CliContext } from "@/context.ts";
import { type HistoryActions, HistoryView, previousOf } from "./history-view.tsx";

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
