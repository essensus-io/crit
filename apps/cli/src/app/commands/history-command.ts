import { defineCommand } from "citty";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { CliError, EXIT } from "@/shared/lib/errors.ts";
import { type HistoryArgs } from "@/features/review-history/lib/history-rows.ts";
import { historyCommand } from "@/app/runners/history/run-history.ts";
import { pruneReviews } from "@/app/runners/history/prune-reviews.ts";
import { removeReview } from "@/app/runners/history/remove-review.ts";

const filterArgs = {
  branch: { type: "string", description: "Only this branch" },
  scope: { type: "string", description: "Scope label contains this text" },
  provider: { type: "string", description: "Only this provider" },
  since: { type: "string", description: "Since a date (2026-11-01) or an age (7d)" },
  "all-repos": { type: "boolean", description: "Reviews from every repo" },
  limit: { type: "string", description: "Max rows (default 50)" },
  json: { type: "boolean", description: "Print JSON" },
} as const;

export const historyDef = (ctx: CliContext) =>
  defineCommand({
    meta: {
      name: "history",
      description: "Browse past reviews; --compare <a> <b>; rm <id>; prune --older-than 90d",
    },
    args: {
      ...filterArgs,
      compare: {
        type: "boolean",
        description: "Compare two reviews: crit history --compare <a> <b>",
      },
      list: { type: "boolean", description: "With --compare: list every finding" },
      tui: { type: "boolean", default: true, description: "Open the history screen in a terminal" },
      "older-than": { type: "string", description: "With prune: age, e.g. 90d" },
      yes: { type: "boolean", alias: "y", description: "With rm/prune: do not ask" },
    },
    run: async ({ args }) => {
      const pos = (args._ ?? []).map(String);
      if (pos[0] === "rm") {
        if (!pos[1])
          throw new CliError("crit: crit history rm <review-id>", { exitCode: EXIT.usage });
        process.exitCode = await removeReview(ctx, pos[1], args.yes);
      } else if (pos[0] === "prune") process.exitCode = await pruneReviews(ctx, args as never);
      else
        process.exitCode = await historyCommand(ctx, {
          ...(args as unknown as HistoryArgs),
          _: pos,
        });
    },
  });
