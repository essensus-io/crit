import { x } from "tinyexec";

export class GitError extends Error {
  readonly args: string[];
  readonly exitCode: number | undefined;
  readonly stderr: string;
  constructor(args: string[], exitCode: number | undefined, stderr: string) {
    super(
      `git ${args.join(" ")} failed${exitCode === undefined ? "" : ` (${exitCode})`}: ${stderr.trim()}`,
    );
    this.name = "GitError";
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export type GitResult = { stdout: string; stderr: string; exitCode: number };

/** Run git and return the full result without throwing. */
export async function gitRaw(cwd: string, args: string[], input?: string): Promise<GitResult> {
  const proc = x("git", ["-c", "core.quotepath=off", ...args], {
    nodeOptions: { cwd, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] },
    throwOnError: false,
  });
  if (input !== undefined) {
    proc.process?.stdin?.end(input);
  }
  const r = await proc;
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode ?? 1 };
}

/** Run git, throw GitError on a non-zero exit. */
export async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const r = await gitRaw(cwd, args, input);
  if (r.exitCode !== 0) throw new GitError(args, r.exitCode, r.stderr);
  return r.stdout;
}

export async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  const r = await gitRaw(cwd, args);
  return r.exitCode === 0 ? r.stdout.trim() : undefined;
}

export async function repoRoot(cwd: string): Promise<string> {
  const out = await tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!out) throw new Error(`crit: ${cwd} is not inside a git repository`);
  return out;
}

export async function headSha(cwd: string): Promise<string | undefined> {
  return tryGit(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
}

export async function currentBranch(cwd: string): Promise<string | undefined> {
  const b = await tryGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return b || undefined;
}

export async function remoteUrl(cwd: string): Promise<string | null> {
  return (await tryGit(cwd, ["remote", "get-url", "origin"])) ?? null;
}

export async function refExists(cwd: string, ref: string): Promise<boolean> {
  return (await tryGit(cwd, ["rev-parse", "--verify", "-q", `${ref}^{commit}`])) !== undefined;
}

/**
 * Base branch for branch reviews. An upstream that tracks a different branch
 * wins (a feature branch created from origin/main). Otherwise the nearest of
 * origin/HEAD and the usual integration branches: the one the current branch
 * is fewest commits ahead of. Taking origin/HEAD blindly reviewed a branch off
 * `develop` against a `main` five weeks behind, 1,576 files instead of 27.
 * Refs that HEAD is not ahead of (the branch itself, its ancestors) are skipped.
 */
export async function detectBase(cwd: string): Promise<string | undefined> {
  const branch = await currentBranch(cwd);
  const upstream = await tryGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstream && branch && upstream.split("/").slice(1).join("/") !== branch) return upstream;
  // The base the branch was created for, when git or `gh` recorded it.
  if (branch)
    for (const key of ["gh-merge-base", "vscode-merge-base"]) {
      const configured = await tryGit(cwd, ["config", "--get", `branch.${branch}.${key}`]);
      if (configured && (await refExists(cwd, configured))) return configured;
    }
  const names: string[] = [];
  const originHead = await tryGit(cwd, [
    "symbolic-ref",
    "--short",
    "-q",
    "refs/remotes/origin/HEAD",
  ]);
  if (originHead) names.push(originHead);
  // Remote refs first: a local develop can be stale, and ties keep this order.
  for (const c of [
    "origin/main",
    "origin/master",
    "origin/trunk",
    "origin/develop",
    "main",
    "master",
    "trunk",
    "develop",
  ])
    if (!names.includes(c)) names.push(c);
  const scored: { ref: string; ahead: number }[] = [];
  let anyExisting: string | undefined;
  for (const ref of names) {
    if (ref === branch || ref === `origin/${branch}`) continue;
    if (!(await refExists(cwd, ref))) continue;
    anyExisting ??= ref;
    const ahead = Number(await tryGit(cwd, ["rev-list", "--count", `${ref}..HEAD`]));
    if (Number.isFinite(ahead)) scored.push({ ref, ahead });
  }
  // Nothing to compare against: fall back to any existing branch.
  if (scored.length === 0) return anyExisting;
  // The branch it will merge into is the nearest one: fewest commits ahead wins (0 means
  // already merged there); ties keep the order above (origin/HEAD first).
  const best = scored.reduce((b, c) => (c.ahead < b.ahead ? c : b));
  if (best.ahead > 0) return best.ref;
  // Already merged into it: review what the merge brought in, i.e. compare against the
  // base as it was just before that merge commit (what the pull request showed).
  const merge = (
    await tryGit(cwd, [
      "rev-list",
      "--ancestry-path",
      "--merges",
      "--first-parent",
      `HEAD..${best.ref}`,
    ])
  )
    ?.split("\n")
    .filter(Boolean)
    .pop();
  const before = merge
    ? await tryGit(cwd, ["rev-parse", "--verify", "-q", `${merge}^1`])
    : undefined;
  return before || best.ref;
}

/** Branches this one could be compared against, with how many commits it is ahead of each. */
export async function candidateBases(cwd: string): Promise<{ ref: string; ahead: number }[]> {
  const branch = await currentBranch(cwd);
  const out: { ref: string; ahead: number }[] = [];
  for (const ref of [
    "origin/main",
    "origin/master",
    "origin/develop",
    "origin/trunk",
    "main",
    "master",
    "develop",
    "trunk",
  ]) {
    if (ref === branch || ref === `origin/${branch}`) continue;
    if (out.some((o) => o.ref === `origin/${ref}`)) continue;
    if (!(await refExists(cwd, ref))) continue;
    const ahead = Number(await tryGit(cwd, ["rev-list", "--count", `${ref}..HEAD`]));
    out.push({ ref, ahead: Number.isFinite(ahead) ? ahead : 0 });
  }
  return out;
}

/** NUL-separated output → list. */
export const splitZ = (s: string) => s.split("\0").filter(Boolean);

export async function trackedFiles(cwd: string): Promise<string[]> {
  return splitZ(await git(cwd, ["ls-files", "-z", "--cached"]));
}

export async function untrackedFiles(cwd: string): Promise<string[]> {
  return splitZ(await git(cwd, ["ls-files", "-z", "--others", "--exclude-standard"]));
}

/** The empty tree object, used to diff the root commit. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
