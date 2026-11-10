import { defineCommand } from "citty";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { undoCommand } from "@/app/runners/apply/run-undo.ts";

export const undoDef = (ctx: CliContext) =>
  defineCommand({
    meta: { name: "undo", description: "Undo the last crit apply" },
    args: {
      force: { type: "boolean", description: "Restore even if files changed after applying" },
    },
    run: async ({ args }) => {
      process.exitCode = await undoCommand(ctx, args);
    },
  });
