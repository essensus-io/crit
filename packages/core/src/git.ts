import { realpathSync } from "node:fs";
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

export async function gitRaw(cwd: string, args: string[], input?: string): Promise<GitResult> {
  const proc = x("git", ["-c", "core.quotepath=off", ...args], {
    nodeOptions: { cwd, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] },
    throwOnError: false,
  });
  if (input !== undefined) {
    proc.process?.stdin?.end(input);
  }
  const output = await proc;
  return { stdout: output.stdout, stderr: output.stderr, exitCode: output.exitCode ?? 1 };
}

export async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const gitResult = await gitRaw(cwd, args, input);
  if (gitResult.exitCode !== 0) throw new GitError(args, gitResult.exitCode, gitResult.stderr);
  return gitResult.stdout;
}

export async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  const gitResult = await gitRaw(cwd, args);
  return gitResult.exitCode === 0 ? gitResult.stdout.trim() : undefined;
}

export async function repoRoot(cwd: string): Promise<string> {
  const out = await tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!out) throw new Error(`crit: ${cwd} is not inside a git repository`);
  // git prints forward slashes and long names on Windows; match the paths callers hold
  return realpathSync.native(out);
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

export async function detectBase(cwd: string): Promise<string | undefined> {
  const branch = await currentBranch(cwd);
  const upstream = await tryGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstream && branch && upstream.split("/").slice(1).join("/") !== branch) return upstream;
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
  if (scored.length === 0) return anyExisting;
  const best = scored.reduce((b, c) => (c.ahead < b.ahead ? c : b));
  if (best.ahead > 0) return best.ref;
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

export const splitZ = (s: string) => s.split("\0").filter(Boolean);

export async function trackedFiles(cwd: string): Promise<string[]> {
  return splitZ(await git(cwd, ["ls-files", "-z", "--cached"]));
}

export async function untrackedFiles(cwd: string): Promise<string[]> {
  return splitZ(await git(cwd, ["ls-files", "-z", "--others", "--exclude-standard"]));
}

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
