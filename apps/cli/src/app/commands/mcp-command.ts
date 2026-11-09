import { runMcpStdio } from "@crit/mcp";
import { defineCommand } from "citty";
import { type CliContext, sessionsDir } from "@/shared/lib/cli-context.ts";

export const mcpCommand = (ctx: CliContext) =>
  defineCommand({
    meta: {
      name: "mcp",
      description: "Run the crit MCP server for one review session (started by the agent CLI)",
    },
    args: {
      session: { type: "string", required: true, description: "Session id" },
      "sessions-dir": { type: "string", description: "Folder holding session files (set by crit)" },
    },
    run: async ({ args }) => {
      await runMcpStdio(args["sessions-dir"] ?? sessionsDir(ctx), args.session, ctx.version);
    },
  });
