import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { discoverRules, git, loadRules, resolveScope, ruleLabel, type RuleSet } from "@crit/core";
import { resolveConfig } from "@crit/schema";
import { loadProjectConfig, loadUserConfig, writeJsonAtomic } from "@crit/store";
import { defineCommand } from "citty";
import type { CliContext } from "../context.ts";
import { CliError, EXIT } from "../shared/lib/index.ts";
import { colors, plural, table } from "../ui.ts";
import { repoRootOrThrow } from "./shared.ts";

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

export function renderRules(set: RuleSet, c: ReturnType<typeof colors>, all: boolean): string {
  const out: string[] = [];
  const regular = set.all.filter((r) => r.kind !== "skill" && r.kind !== "claude-agent");
  if (regular.length === 0 && set.skills.length === 0)
    out.push("No rules found. Add CLAUDE.md, AGENTS.md, .cursor/rules or .crit/rules/*.md.");
  if (regular.length) {
    const rows = [
      [c.dim("ID"), c.dim("LAYER"), c.dim("APPLIES TO"), c.dim("RULE"), c.dim("SOURCE")],
    ];
    for (const r of regular) {
      const applies = r.alwaysApply
        ? "always"
        : r.globs.length
          ? r.globs.join(", ")
          : r.scopeDir
            ? `${r.scopeDir}/**`
            : "all files";
      rows.push([r.id, r.layer, applies, r.title, c.dim(ruleLabel(r))]);
    }
    out.push(c.bold(`Rules (${regular.length})`), table(rows));
  }
  if (set.skills.length) {
    out.push("", c.bold(`Skills and agents (${set.skills.length}, listed by name for the agent)`));
    out.push(
      table(set.skills.map((r) => [r.id, r.title, c.dim(r.description ?? ""), c.dim(r.path)])),
    );
  }
  if (set.conflicts.length) {
    out.push("", c.yellow(c.bold(`Conflicts (${set.conflicts.length})`)));
    for (const k of set.conflicts)
      out.push(
        `  "${k.topic}": ${k.winner} wins over ${k.ruleIds.filter((x) => x !== k.winner).join(", ")} (user > project > global)`,
      );
  }
  if (set.filtered.length) {
    out.push(
      "",
      c.dim(
        `${plural(set.filtered.length, "section")} skipped as not about review${all ? ":" : " (crit rules --all to list)"}`,
      ),
    );
    if (all) for (const r of set.filtered) out.push(c.dim(`  - ${ruleLabel(r)}`));
  }
  if (set.errors.length) {
    out.push("", c.red(c.bold("Errors")));
    for (const e of set.errors) out.push(c.red(`  ${e}`));
  }
  return `${out.join("\n")}\n`;
}

type PackRecord = { name: string; url: string; ref?: string; commit: string; addedAt: number };

export async function addRules(
  ctx: CliContext,
  source: string,
  opts: { name?: string; ref?: string } = {},
): Promise<number> {
  const rulesDir = join(ctx.paths.config, "rules");
  mkdirSync(rulesDir, { recursive: true });
  const local = resolve(ctx.cwd, source);
  if (existsSync(local)) {
    const dest = join(rulesDir, opts.name ?? basename(local));
    if (existsSync(dest))
      throw new CliError(`crit: ${dest} already exists`, {
        hint: "Pass --name to pick another name.",
      });
    cpSync(local, dest, { recursive: statSync(local).isDirectory() });
    ctx.out(`Added ${source} → ${dest}\n`);
    return EXIT.ok;
  }
  const m = /^github:([\w.-]+\/[\w.-]+)(?:#(.+))?$/.exec(source);
  const url = m ? `https://github.com/${m[1]}.git` : source;
  const ref = opts.ref ?? m?.[2];
  if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(url))
    throw new CliError(`crit: ${source} is not a file, folder or git URL`, {
      exitCode: EXIT.usage,
    });
  const name = opts.name ?? basename(url).replace(/\.git$/, "");
  const dest = join(rulesDir, "packs", name);
  if (existsSync(dest))
    throw new CliError(`crit: pack ${name} is already installed`, {
      hint: `Remove ${dest} to re-add it.`,
    });
  mkdirSync(join(rulesDir, "packs"), { recursive: true });
  await git(ctx.cwd, [
    "clone",
    "--quiet",
    "--depth",
    "1",
    ...(ref ? ["--branch", ref] : []),
    url,
    dest,
  ]);
  const commit = (await git(dest, ["rev-parse", "HEAD"])).trim();
  const indexPath = join(rulesDir, "packs.json");
  const packs: PackRecord[] = existsSync(indexPath)
    ? JSON.parse(readFileSync(indexPath, "utf8"))
    : [];
  packs.push({ name, url, ...(ref ? { ref } : {}), commit, addedAt: ctx.now() });
  writeJsonAtomic(indexPath, packs);
  ctx.out(`Added pack ${name} pinned to ${commit.slice(0, 12)} → ${dest}\n`);
  return EXIT.ok;
}

export async function importCursorRules(ctx: CliContext, text?: string): Promise<number> {
  let body = text;
  if (body === undefined) {
    if (!ctx.interactive)
      throw new CliError("crit: pass the rules text with --text, or run in a terminal", {
        exitCode: EXIT.usage,
      });
    ctx.prompter.info(
      "Open Cursor → Settings → Rules, copy your User Rules, and paste them below.",
    );
    body = await ctx.prompter.text({
      message: "Cursor user rules",
      validate: (v) => (v.trim() ? undefined : "paste at least one rule"),
    });
  }
  const dest = join(ctx.paths.config, "rules", "cursor-user-rules.md");
  mkdirSync(join(ctx.paths.config, "rules"), { recursive: true });
  writeFileSync(dest, `---\ntitle: Cursor user rules\n---\n${body.trim()}\n`);
  ctx.out(`Saved ${dest}\n`);
  return EXIT.ok;
}

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
