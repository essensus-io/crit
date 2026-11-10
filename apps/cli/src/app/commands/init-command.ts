import { defineCommand } from "citty";
import { type CliContext } from "@/shared/lib/cli-context.ts";
import { init } from "@/app/runners/init/run-init.ts";

export const initCommand = (ctx: CliContext) =>
  defineCommand({
    meta: { name: "init", description: "Create .crit/config.json for team settings (optional)" },
    args: {
      force: { type: "boolean" },
      provider: { type: "string", description: "Preferred provider name for the team" },
    },
    run: async ({ args }) => {
      process.exitCode = await init(ctx, args);
    },
  });
