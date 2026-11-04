import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_IGNORES, type ResolvedScope, type ScopedFile, type ScopeSpec } from "@crit/schema";
import picomatch from "picomatch";
import { diffPath, hunksOf, type ParsedFile, parseUnifiedDiff } from "./diff.ts";
import {
  currentBranch,
  detectBase,
  EMPTY_TREE,
  git,
  headSha,
  repoRoot,
  trackedFiles,
  tryGit,
  untrackedFiles,
} from "./git.ts";

export type ResolveScopeOptions = {
  cwd: string;
  spec: ScopeSpec;
  /** Extra ignore globs (config `ignore`), on top of the secret/lockfile defaults. */
  ignore?: string[];
};

export class ScopeError extends Error {
  override name = "ScopeError";
}

const toPosix = (p: string) => p.split(sep).join("/");

/** Matcher for ignored paths: secrets, keys, lockfiles and user ignores. */
export function ignoreMatcher(extra: string[] = []): (path: string) => boolean {
  return picomatch([...DEFAULT_IGNORES, ...extra], { dot: true });
}

function looksBinary(abs: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(abs, "r");
    const buf = Buffer.alloc(8000);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function fileSize(abs: string): number {
  try {
    return statSync(abs).size;
  } catch {
    return 0;
  }
}

/** Synthesize an "added file" diff for an untracked file. */
function untrackedDiff(root: string, path: string): string {
  const content = readFileSync(join(root, path), "utf8");
  const lines = content.split("\n");
  const noEol = !content.endsWith("\n");
  if (!noEol) lines.pop();
  const body = lines.map((l) => `+${l}`).join("\n");
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
    ...(noEol ? ["\\ No newline at end of file"] : []),
    "",
  ].join("\n");
}

const DIFF_ARGS = ["diff", "--no-color", "--no-ext-diff", "--find-renames", "-U3"];

type DiffSet = { files: ParsedFile[]; text: string; skipped: string[] };

async function diffAgainst(
  root: string,
  args: string[],
  includeUntracked: boolean,
): Promise<DiffSet> {
  let text = await git(root, [...DIFF_ARGS, ...args]);
  const skipped: string[] = [];
  if (includeUntracked) {
    for (const p of await untrackedFiles(root)) {
      if (looksBinary(join(root, p))) skipped.push(p);
      else text += untrackedDiff(root, p);
    }
  }
  return { files: parseUnifiedDiff(text), text, skipped };
}

async function branchDiff(
  root: string,
  base: string | undefined,
): Promise<DiffSet & { base: string; baseSha: string }> {
  const ref = base ?? (await detectBase(root));
  if (!ref) {
    throw new ScopeError(
      "crit: could not detect a base branch (no upstream, origin/HEAD or main/master). Pass --base <branch>.",
    );
  }
  const mb = await tryGit(root, ["merge-base", "HEAD", ref]);
  if (!mb)
    throw new ScopeError(`crit: no common ancestor between HEAD and ${ref}. Pass --base <branch>.`);
  return { ...(await diffAgainst(root, [mb], true)), base: ref, baseSha: mb };
}

function scopedFromDiff(
  root: string,
  files: ParsedFile[],
): { files: ScopedFile[]; binary: string[] } {
  const out: ScopedFile[] = [];
  const binary: string[] = [];
  for (const f of files) {
    const path = diffPath(f);
    if (f.binary) {
      binary.push(path);
      continue;
    }
    const sf: ScopedFile = {
      path,
      status: f.status,
      hunks: hunksOf(f),
      size: f.status === "deleted" ? 0 : fileSize(join(root, path)),
    };
    if (f.status === "renamed" && f.oldPath) sf.oldPath = f.oldPath;
    out.push(sf);
  }
  return { files: out, binary };
}

/** Normalize CLI path args (relative to cwd, possibly globs) into repo-relative matchers. */
export function pathMatcher(root: string, cwd: string, args: string[]): (file: string) => boolean {
  const prefixes: string[] = [];
  const globs: string[] = [];
  const cwdRel = toPosix(relative(root, cwd));
  for (const raw of args) {
    const arg = toPosix(raw).replace(/\/+$/, "");
    if (picomatch.scan(arg).isGlob) {
      globs.push(cwdRel && !arg.startsWith("/") ? `${cwdRel}/${arg}` : arg.replace(/^\//, ""));
    } else {
      const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
      const rel = toPosix(relative(root, abs));
      if (rel.startsWith("..")) throw new ScopeError(`crit: ${raw} is outside the repository`);
      prefixes.push(rel === "." ? "" : rel);
    }
  }
  const isGlobMatch = globs.length ? picomatch(globs, { dot: true }) : () => false;
  return (file) =>
    prefixes.some((p) => p === "" || file === p || file.startsWith(`${p}/`)) || isGlobMatch(file);
}

function filterIgnored<T extends { path: string }>(items: T[], isIgnored: (p: string) => boolean) {
  const kept: T[] = [];
  const ignored: string[] = [];
  for (const it of items) {
    if (isIgnored(it.path)) ignored.push(it.path);
    else kept.push(it);
  }
  return { kept, ignored };
}

/**
 * Turn a scope spec into the set of files (and, for diffs, hunks) that findings
 * may be reported on. The agent can still read the whole repo for context.
 */
export async function resolveScope(opts: ResolveScopeOptions): Promise<ResolvedScope> {
  const root = await repoRoot(opts.cwd);
  const { spec } = opts;
  const isIgnored = ignoreMatcher(opts.ignore);
  const head = await headSha(root);
  const branch = await currentBranch(root);
  const base: Omit<ResolvedScope, "files" | "label"> = { spec, root, ignored: [] };
  if (head) base.headSha = head;
  if (branch) base.branch = branch;

  const fromDiff = (
    set: DiffSet,
    label: string,
    extra: Partial<ResolvedScope> = {},
  ): ResolvedScope => {
    const { files, binary } = scopedFromDiff(root, set.files);
    const { kept, ignored } = filterIgnored(files, isIgnored);
    return {
      ...base,
      ...extra,
      label,
      files: kept,
      diff: set.text,
      ignored: [...ignored, ...binary, ...set.skipped],
    };
  };

  const fromList = (paths: string[], label: string): ResolvedScope => {
    const binary: string[] = [];
    const files: ScopedFile[] = [];
    for (const p of paths) {
      const abs = join(root, p);
      if (looksBinary(abs)) {
        binary.push(p);
        continue;
      }
      files.push({ path: p, status: "unchanged", size: fileSize(abs) });
    }
    const { kept, ignored } = filterIgnored(files, isIgnored);
    return { ...base, label, files: kept, ignored: [...ignored, ...binary] };
  };

  switch (spec.kind) {
    case "branch": {
      if (!head)
        throw new ScopeError("crit: the repository has no commits yet. Try `crit review --all`.");
      const d = await branchDiff(root, spec.base);
      return fromDiff(d, `${branch ?? head.slice(0, 7)} → ${d.base}`, {
        baseSha: d.baseSha,
        baseRef: d.base,
      });
    }
    case "staged": {
      const d = await diffAgainst(root, ["--cached", ...(head ? [] : [EMPTY_TREE])], false);
      return fromDiff(d, "staged changes", head ? { baseSha: head, baseRef: "HEAD" } : {});
    }
    case "commit": {
      const sha = await tryGit(root, ["rev-parse", "--verify", "-q", `${spec.sha}^{commit}`]);
      if (!sha) throw new ScopeError(`crit: unknown commit ${spec.sha}`);
      const parent = (await tryGit(root, ["rev-parse", "--verify", "-q", `${sha}^`])) ?? EMPTY_TREE;
      const d = await diffAgainst(root, [parent, sha], false);
      return fromDiff(d, `commit ${sha.slice(0, 7)}`, { baseSha: parent, headSha: sha });
    }
    case "paths": {
      const match = pathMatcher(root, opts.cwd, spec.paths);
      const label = spec.paths.join(" ");
      if (spec.diff) {
        const d = await branchDiff(root, spec.base);
        const r = fromDiff(d, `${label} (changed vs ${d.base})`, {
          baseSha: d.baseSha,
          baseRef: d.base,
        });
        return { ...r, files: r.files.filter((f) => match(f.path)) };
      }
      const tracked = (await trackedFiles(root)).filter(match);
      if (tracked.length === 0) throw new ScopeError(`crit: no tracked files match ${label}`);
      return fromList(tracked, label);
    }
    case "project":
      return fromList(await trackedFiles(root), "whole project");
  }
}

/** Repo-relative paths a finding may be reported on. */
export function reportableFiles(scope: ResolvedScope): Set<string> {
  return new Set(scope.files.filter((f) => f.status !== "deleted").map((f) => f.path));
}
