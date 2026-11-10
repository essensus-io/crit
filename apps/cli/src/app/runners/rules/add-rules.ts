import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { git } from "@crit/core";
import { writeJsonAtomic } from "@crit/store";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { CliError, EXIT } from "@/shared/lib/errors.ts";

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
  const match = /^github:([\w.-]+\/[\w.-]+)(?:#(.+))?$/.exec(source);
  const url = match ? `https://github.com/${match[1]}.git` : source;
  const ref = opts.ref ?? match?.[2];
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
