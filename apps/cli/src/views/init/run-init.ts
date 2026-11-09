import { existsSync } from "node:fs";
import { projectConfigPath, saveProjectConfig } from "@crit/store";
import { type CliContext } from "@/shared/lib/cli-context.ts";
import { CliError, EXIT } from "@/shared/lib/errors.ts";
import { repoRootOrThrow } from "@/shared/lib/repo-root-or-throw.ts";

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
