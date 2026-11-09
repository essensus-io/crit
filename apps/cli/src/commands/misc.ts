import { existsSync } from "node:fs";
import { runMcpStdio } from "@crit/mcp";
import { projectConfigPath, saveProjectConfig } from "@crit/store";
import { defineCommand } from "citty";
import { type CliContext, sessionsDir } from "../context.ts";
import { CliError, EXIT } from "../shared/lib/errors.ts";
import { repoRootOrThrow } from "./shared.ts";

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

export async function init(
  ctx: CliContext,
  opts: { force?: boolean; provider?: string } = {},
): Promise<number> {
  const root = await repoRootOrThrow(ctx.cwd);
  const path = projectConfigPath(root);
  if (existsSync(path) && !opts.force)
    throw new CliError(`crit: ${path} already exists`, { hint: "Pass --force to overwrite it." });
  saveProjectConfig(root, {
    $schema: "https://unpkg.com/crit/schema/config.json",
    ...(opts.provider ? { provider: opts.provider } : {}),
    lenses: ["correctness", "security", "performance", "maintainability"],
    ignore: [],
    review: { allowedCommands: [] },
    verify: { commands: [] },
  });
  ctx.out(
    `Created ${path}\nCommit it to share review settings with your team. Rules go in .crit/rules/*.md.\n`,
  );
  return EXIT.ok;
}

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
