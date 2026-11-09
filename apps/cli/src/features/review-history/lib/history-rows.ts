import { type HistoryRow, listHistory, type SqliteStore } from "@crit/store";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { repoRootOrThrow } from "@/shared/lib/repo-root-or-throw.ts";
import { parseSince } from "./parse-age.ts";

export type HistoryArgs = {
  branch?: string;
  scope?: string;
  provider?: string;
  since?: string;
  "all-repos"?: boolean;
  limit?: string;
  json?: boolean;
};

export async function historyRows(
  ctx: CliContext,
  store: SqliteStore,
  args: HistoryArgs,
): Promise<HistoryRow[]> {
  let repoId: string | undefined;
  if (!args["all-repos"]) {
    const root = await repoRootOrThrow(ctx.cwd);
    repoId = (await store.repos.getByRoot(root))?.id;
    if (!repoId) return [];
  }
  return listHistory(store.db, {
    ...(repoId ? { repoId } : {}),
    ...(args.branch ? { branch: args.branch } : {}),
    ...(args.scope ? { scope: args.scope } : {}),
    ...(args.provider ? { provider: args.provider } : {}),
    ...(args.since ? { since: parseSince(args.since, ctx.now()) } : {}),
    limit: args.limit ? Number(args.limit) : 50,
  });
}
