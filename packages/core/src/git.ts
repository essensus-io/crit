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
 * Base branch for branch reviews: the upstream when it tracks a different
 * branch (e.g. a feature branch created from origin/main), else origin/HEAD,
 * else a local main/master/trunk/develop.
 */
export async function detectBase(cwd: string): Promise<string | undefined> {
  const branch = await currentBranch(cwd);
  const upstream = await tryGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstream && branch && upstream.split("/").slice(1).join("/") !== branch) return upstream;
  const originHead = await tryGit(cwd, [
    "symbolic-ref",
    "--short",
    "-q",
    "refs/remotes/origin/HEAD",
  ]);
  if (originHead) return originHead;
  for (const candidate of ["main", "master", "trunk", "develop", "origin/main", "origin/master"]) {
    if (candidate !== branch && (await refExists(cwd, candidate))) return candidate;
  }
  return undefined;
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
