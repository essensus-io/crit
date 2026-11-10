import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  BINARY_EXTENSIONS,
  NOISE_IGNORES,
  type ResolvedScope,
  type ScopedFile,
  type ScopeSpec,
  SECRET_IGNORES,
} from "@crit/schema";
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
import { defaultBaseFor, resolveRefTarget } from "./ref-target.ts";

export type ResolveScopeOptions = {
  cwd: string;
  spec: ScopeSpec;
  ignore?: string[];
  maxFileTokens?: number;
};

export class ScopeError extends Error {
  override name = "ScopeError";
}

const fmtTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const toPosix = (p: string) => p.split(sep).join("/");

export function ignoreMatcher(extra: string[] = []): (path: string) => boolean {
  const why = skipReasonMatcher(extra);
  return (path) => why(path) !== undefined;
}

export function skipReasonMatcher(
  extra: string[] = [],
): (path: string, named?: boolean) => string | undefined {
  const secret = picomatch(SECRET_IGNORES, { dot: true });
  const noise = picomatch(NOISE_IGNORES, { dot: true });
  const user = extra.length ? picomatch(extra, { dot: true }) : () => false;
  return (path, named) => {
    if (secret(path)) return "secret, key or lockfile";
    if (user(path)) return "ignored by config";
    if (!named && noise(path)) return "docs, assets or generated (default ignore)";
    return undefined;
  };
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

function untrackedDiff(root: string, path: string): string {
  const content = readFileSync(join(root, path), "utf8");
  const lines = content.split("\n");
  const noEol = !content.endsWith("\n");
  if (!noEol) lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
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
): { files: ScopedFile[]; skipped: { path: string; reason: string }[] } {
  const out: ScopedFile[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const parsedFile of files) {
    const path = diffPath(parsedFile);
    if (parsedFile.binary || BINARY_EXTENSIONS.test(path)) {
      skipped.push({ path, reason: "binary file" });
      continue;
    }
    if (parsedFile.status === "renamed" && parsedFile.hunks.length === 0) {
      skipped.push({ path, reason: "renamed without changes" });
      continue;
    }
    const sf: ScopedFile = {
      path,
      status: parsedFile.status,
      hunks: hunksOf(parsedFile),
      size: parsedFile.status === "deleted" ? 0 : fileSize(join(root, path)),
    };
    if (parsedFile.status === "renamed" && parsedFile.oldPath) sf.oldPath = parsedFile.oldPath;
    out.push(sf);
  }
  return { files: out, skipped };
}

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
    prefixes.some((prefix) => prefix === "" || file === prefix || file.startsWith(`${prefix}/`)) ||
    isGlobMatch(file);
}

function filterIgnored<T extends { path: string }>(
  items: T[],
  why: (path: string, named?: boolean) => string | undefined,
  named: Set<string> = new Set(),
) {
  const kept: T[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const t of items) {
    const reason = why(t.path, named.has(t.path));
    if (reason) skipped.push({ path: t.path, reason });
    else kept.push(t);
  }
  return { kept, skipped };
}

export async function resolveScope(opts: ResolveScopeOptions): Promise<ResolvedScope> {
  const root = await repoRoot(opts.cwd);
  const { spec } = opts;
  const why = skipReasonMatcher(opts.ignore);
  const maxFileBytes = (opts.maxFileTokens ?? 20_000) * 4;
  const head = await headSha(root);
  const branch = await currentBranch(root);
  const base: Omit<ResolvedScope, "files" | "label"> = { spec, root, ignored: [], skipped: [] };
  if (head) base.headSha = head;
  if (branch) base.branch = branch;

  let named = new Set<string>();
  const fromDiff = (
    set: DiffSet,
    label: string,
    extra: Partial<ResolvedScope> = {},
  ): ResolvedScope => {
    const { files, skipped: dropped } = scopedFromDiff(root, set.files);
    const { kept, skipped } = filterIgnored(files, why, named);
    const all = [
      ...skipped,
      ...dropped,
      ...set.skipped.map((path) => ({ path, reason: "binary file" })),
    ];
    return {
      ...base,
      ...extra,
      label,
      files: kept,
      diff: set.text,
      ignored: all.map((x) => x.path),
      skipped: all,
    };
  };

  const fromList = (
    paths: string[],
    label: string,
    named: Set<string> = new Set(),
  ): ResolvedScope => {
    const dropped: { path: string; reason: string }[] = [];
    const files: ScopedFile[] = [];
    for (const path of paths) {
      const abs = join(root, path);
      if (BINARY_EXTENSIONS.test(path) || looksBinary(abs)) {
        dropped.push({ path: path, reason: "binary file" });
        continue;
      }
      const size = fileSize(abs);
      if (size > maxFileBytes && !named.has(path)) {
        dropped.push({ path: path, reason: `larger than ${fmtTokens(maxFileBytes / 4)} tokens` });
        continue;
      }
      files.push({ path: path, status: "unchanged", size });
    }
    const { kept, skipped } = filterIgnored(files, why, named);
    const all = [...skipped, ...dropped];
    return { ...base, label, files: kept, ignored: all.map((x) => x.path), skipped: all };
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
    case "ref": {
      const target = await resolveRefTarget(root, spec.ref);
      const baseRef = spec.base ?? (await defaultBaseFor(root, target));
      if (!baseRef)
        throw new ScopeError("crit: could not detect a base branch. Pass --base <branch>.");
      const baseSha = await tryGit(root, ["merge-base", target.sha, baseRef]);
      if (!baseSha)
        throw new ScopeError(`crit: no common ancestor between ${target.branch} and ${baseRef}.`);
      const diffSet = await diffAgainst(root, [baseSha, target.sha], false);
      return fromDiff(diffSet, `${target.label} → ${baseRef}`, {
        baseSha,
        baseRef,
        headSha: target.sha,
        branch: target.branch,
      });
    }
    case "staged": {
      const diffSet = await diffAgainst(root, ["--cached", ...(head ? [] : [EMPTY_TREE])], false);
      return fromDiff(diffSet, "staged changes", head ? { baseSha: head, baseRef: "HEAD" } : {});
    }
    case "commit": {
      const sha = await tryGit(root, ["rev-parse", "--verify", "-q", `${spec.sha}^{commit}`]);
      if (!sha) throw new ScopeError(`crit: unknown commit ${spec.sha}`);
      const parent = (await tryGit(root, ["rev-parse", "--verify", "-q", `${sha}^`])) ?? EMPTY_TREE;
      const diffSet = await diffAgainst(root, [parent, sha], false);
      return fromDiff(diffSet, `commit ${sha.slice(0, 7)}`, { baseSha: parent, headSha: sha });
    }
    case "paths": {
      const match = pathMatcher(root, opts.cwd, spec.paths);
      const label = spec.paths.join(" ");
      if (spec.diff) {
        const d = await branchDiff(root, spec.base);
        named = namedFiles(root, opts.cwd, spec.paths, d.files.map(diffPath));
        const result = fromDiff(d, `${label} (changed vs ${d.base})`, {
          baseSha: d.baseSha,
          baseRef: d.base,
        });
        return { ...result, files: result.files.filter((file) => match(file.path)) };
      }
      const tracked = (await trackedFiles(root)).filter(match);
      if (tracked.length === 0) throw new ScopeError(`crit: no tracked files match ${label}`);
      return fromList(tracked, label, namedFiles(root, opts.cwd, spec.paths, tracked));
    }
    case "project":
      return fromList(await trackedFiles(root), "whole project");
  }
}

export function namedFiles(
  root: string,
  cwd: string,
  args: string[],
  candidates: string[],
): Set<string> {
  const exact = new Set<string>();
  for (const raw of args) {
    if (picomatch.scan(raw).isGlob) continue;
    const rel = toPosix(relative(root, isAbsolute(raw) ? raw : resolve(cwd, raw)));
    if (candidates.includes(rel)) exact.add(rel);
  }
  return exact;
}

export function reportableFiles(scope: ResolvedScope): Set<string> {
  return new Set(scope.files.filter((file) => file.status !== "deleted").map((f) => f.path));
}
