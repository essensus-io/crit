import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { RuleLayer, RuleSourceKind } from "@crit/schema";
import picomatch from "picomatch";
import { globSync } from "tinyglobby";
import { git, splitZ } from "../git.ts";
import type { RuleFile } from "./parse.ts";

const toPosix = (p: string) => p.split(sep).join("/");

type ProjectPattern = { kind: RuleSourceKind; match: (p: string) => boolean };

const pm = (globs: string | string[]) => picomatch(globs, { dot: true });

const PROJECT_PATTERNS: ProjectPattern[] = [
  {
    kind: "claude-md",
    match: (p) => basename(p) === "CLAUDE.md" || basename(p) === "CLAUDE.local.md",
  },
  { kind: "agents-md", match: (p) => basename(p) === "AGENTS.md" },
  { kind: "cursor-rule", match: pm(".cursor/rules/**/*.mdc") },
  { kind: "cursorrules", match: (p) => p === ".cursorrules" },
  { kind: "skill", match: pm(".claude/skills/*/SKILL.md") },
  { kind: "claude-agent", match: pm(".claude/agents/*.md") },
  { kind: "copilot-instructions", match: (p) => p === ".github/copilot-instructions.md" },
  { kind: "review-md", match: (p) => p === "REVIEW.md" },
  { kind: "crit-rule", match: pm(".crit/rules/**/*.md") },
];

const IGNORED_DIRS = /(^|\/)(node_modules|\.git|dist|build|vendor)\//;

function read(abs: string): string | undefined {
  try {
    if (!statSync(abs).isFile()) return undefined;
    return readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}

export async function discoverProjectRules(
  root: string,
  include: string[] = [],
): Promise<RuleFile[]> {
  const files = splitZ(
    await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
  );
  const extra = include.filter((i) => !/^(github:|git\+|https?:|npm:)/.test(i));
  const isExtra = extra.length ? pm(extra) : () => false;
  const out: RuleFile[] = [];
  const seen = new Set<string>();
  for (const p of [...new Set(files)].sort()) {
    if (IGNORED_DIRS.test(p)) continue;
    const pattern = PROJECT_PATTERNS.find((projectPattern) => projectPattern.match(p));
    const kind: RuleSourceKind | undefined =
      pattern?.kind ?? (isExtra(p) && p.endsWith(".md") ? "crit-rule" : undefined);
    if (!kind || seen.has(p)) continue;
    const content = read(join(root, p));
    if (content === undefined) continue;
    seen.add(p);
    out.push({ layer: "project", kind, path: p, content });
  }
  return out;
}

function homeDisplay(abs: string, home: string): string {
  const rel = toPosix(relative(home, abs));
  return rel.startsWith("..") ? toPosix(abs) : `~/${rel}`;
}

function globFiles(dir: string, pattern: string): string[] {
  if (!existsSync(dir)) return [];
  return globSync(pattern, { cwd: dir, absolute: true, dot: true }).sort();
}

export function discoverGlobalRules(home: string): RuleFile[] {
  const out: RuleFile[] = [];
  const add = (abs: string, kind: RuleSourceKind) => {
    const content = read(abs);
    if (content !== undefined)
      out.push({ layer: "global", kind, path: homeDisplay(abs, home), content });
  };
  add(join(home, ".claude", "CLAUDE.md"), "claude-md");
  for (const f of globFiles(join(home, ".claude", "skills"), "*/SKILL.md")) add(f, "skill");
  for (const f of globFiles(join(home, ".claude", "agents"), "*.md")) add(f, "claude-agent");
  add(join(home, ".codex", "AGENTS.md"), "agents-md");
  for (const f of globFiles(join(home, ".codex", "skills"), "*/SKILL.md")) add(f, "skill");
  return out;
}

export function discoverUserRules(configDir: string, home: string): RuleFile[] {
  const dir = join(configDir, "rules");
  return globFiles(dir, "**/*.md")
    .filter((f) => !/(^|\/)(README|CHANGELOG|LICENSE)\.md$/i.test(toPosix(f)))
    .map((abs) => ({
      layer: "user" as RuleLayer,
      kind: "crit-rule" as RuleSourceKind,
      path: homeDisplay(abs, home),
      content: read(abs)!,
    }));
}
