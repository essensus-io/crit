import { defineCommand } from "citty";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { applyCommand } from "@/app/runners/apply/run-apply.ts";

export const applyDef = (ctx: CliContext) =>
  defineCommand({
    meta: { name: "apply", description: "Apply all checked fixes of a review (latest by default)" },
    args: {
      review: { type: "positional", required: false, description: "Review id (latest by default)" },
      branch: {
        type: "boolean",
        description: "Commit to a new branch crit/fixes-<id> instead of the working tree",
      },
      "branch-name": {
        type: "string",
        description: "Name for the fixes branch (implies --branch)",
      },
      squash: {
        type: "boolean",
        description: "With --branch: one commit instead of one per finding",
      },
      yes: { type: "boolean", alias: "y" },
      verify: { type: "boolean", default: true, description: "Run verify.commands after applying" },
    },
    run: async ({ args }) => {
      process.exitCode = await applyCommand(ctx, args as never);
    },
  });
