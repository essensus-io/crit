import { defineCommand } from "citty";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { CliError, EXIT } from "@/shared/lib/errors.ts";
import { addRules } from "@/views/rules/add-rules.ts";
import { importCursorRules } from "@/views/rules/import-cursor-rules.ts";
import { listRules } from "@/views/rules/list-rules.ts";

export const rulesCommand = (ctx: CliContext) =>
  defineCommand({
    meta: { name: "rules", description: "List discovered rules; add a rule or rule pack" },
    args: {
      all: { type: "boolean", description: "Also list sections skipped as not about review" },
      json: { type: "boolean", description: "Print JSON" },
    },
    subCommands: {
      add: defineCommand({
        meta: {
          name: "add",
          description: "Add a rule file, folder, or git rule pack (pinned to a commit)",
        },
        args: {
          source: { type: "positional", required: true },
          name: { type: "string" },
          ref: { type: "string" },
        },
        run: async ({ args }) => {
          process.exitCode = await addRules(ctx, args.source, args as never);
        },
      }),
      import: defineCommand({
        meta: {
          name: "import",
          description: "Import rules kept outside files (crit rules import --cursor)",
        },
        args: { cursor: { type: "boolean", required: true }, text: { type: "string" } },
        run: async ({ args }) => {
          if (!args.cursor)
            throw new CliError("crit: only --cursor is supported", { exitCode: EXIT.usage });
          process.exitCode = await importCursorRules(ctx, args.text);
        },
      }),
    },
    run: async ({ args, rawArgs }) => {
      if (rawArgs[0] === "add" || rawArgs[0] === "import") return;
      process.exitCode = await listRules(ctx, args);
    },
  });
