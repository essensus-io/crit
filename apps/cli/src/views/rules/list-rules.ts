import { discoverRules, loadRules, resolveScope } from "@crit/core";
import { resolveConfig } from "@crit/schema";
import { loadProjectConfig, loadUserConfig } from "@crit/store";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { EXIT } from "@/shared/lib/errors.ts";
import { colors } from "@/shared/lib/colors.ts";
import { repoRootOrThrow } from "@/shared/lib/repo-root-or-throw.ts";
import { renderRules } from "./render-rules.ts";

export async function listRules(
  ctx: CliContext,
  opts: { all?: boolean; json?: boolean } = {},
): Promise<number> {
  const root = await repoRootOrThrow(ctx.cwd);
  const config = resolveConfig(loadUserConfig(ctx.paths), loadProjectConfig(root));
  const files = await discoverRules({
    root,
    home: ctx.home,
    configDir: ctx.paths.config,
    include: config.rules.include,
    sources: config.rules.sources,
  });
  const scope = await resolveScope({
    cwd: root,
    spec: { kind: "project" },
    ignore: config.ignore,
    maxFileTokens: config.maxFileTokens,
  }).catch(() => undefined);
  const set = await loadRules({
    files,
    scopeFiles: scope?.files.map((f) => f.path) ?? [],
    sources: config.rules.sources,
    exclude: config.rules.exclude,
    budgetTokens: config.rules.budgetTokens,
  });
  if (opts.json) {
    ctx.out(
      `${JSON.stringify({ rules: set.all, filtered: set.filtered, conflicts: set.conflicts, errors: set.errors }, null, 2)}\n`,
    );
    return EXIT.ok;
  }
  ctx.out(renderRules(set, colors(ctx.color), Boolean(opts.all)));
  return set.errors.length ? EXIT.error : EXIT.ok;
}
