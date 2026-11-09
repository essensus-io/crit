import { defineCommand } from "citty";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { openCommand } from "@/views/review/run-open.ts";

export const openDef = (ctx: CliContext) =>
  defineCommand({
    meta: { name: "open", description: "Reopen a saved review (latest by default)" },
    args: {
      review: { type: "positional", required: false },
      tui: {
        type: "boolean",
        default: true,
        description: "Open the review screen (--no-tui prints the report)",
      },
    },
    run: async ({ args }) => {
      process.exitCode = await openCommand(ctx, args);
    },
  });
