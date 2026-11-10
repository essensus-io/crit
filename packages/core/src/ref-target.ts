import { gitRaw, refExists, tryGit } from "./git.ts";

export type RefTarget = { sha: string; branch: string; label: string };

const PULL_URL = /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)/;
const TREE_URL = /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/tree\/(.+?)\/?$/;
const ORIGIN_PREFIX = "origin/";
const BASE_CANDIDATES = [
  "origin/main",
  "origin/master",
  "origin/develop",
  "origin/trunk",
  "main",
  "master",
  "develop",
  "trunk",
];

export class RefTargetError extends Error {
  override name = "RefTargetError";
}

const commitOf = (root: string, ref: string) =>
  tryGit(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);

async function fetchedCommit(root: string, remoteRef: string): Promise<string | undefined> {
  const fetched = await gitRaw(root, ["fetch", "--quiet", "origin", remoteRef]);
  return fetched.exitCode === 0 ? commitOf(root, "FETCH_HEAD") : undefined;
}

export async function resolveRefTarget(root: string, input: string): Promise<RefTarget> {
  const text = input.trim();
  const pull = PULL_URL.exec(text);
  if (pull) {
    const sha = await fetchedCommit(root, `pull/${pull[1]}/head`);
    if (!sha) throw new RefTargetError(`crit: could not fetch pull request ${text} from origin`);
    return { sha, branch: text, label: `PR #${pull[1]}` };
  }
  const tree = TREE_URL.exec(text);
  const name = (tree ? decodeURIComponent(tree[1]!) : text).replace(/^refs\/heads\//, "");
  const branch = name.startsWith(ORIGIN_PREFIX) ? name.slice(ORIGIN_PREFIX.length) : name;
  if (name.startsWith("-") || branch.startsWith("-")) {
    throw new RefTargetError(`crit: invalid branch name ${name}`);
  }
  const sha =
    (await commitOf(root, name)) ??
    (await commitOf(root, `${ORIGIN_PREFIX}${name}`)) ??
    (await fetchedCommit(root, branch));
  if (!sha) throw new RefTargetError(`crit: cannot find branch ${branch} locally or on origin`);
  return { sha, branch, label: branch };
}

const commitsAhead = async (root: string, base: string, sha: string) =>
  Number(await tryGit(root, ["rev-list", "--count", `${base}..${sha}`]));

export async function defaultBaseFor(root: string, target: RefTarget): Promise<string | undefined> {
  const originHead = await tryGit(root, [
    "symbolic-ref",
    "--short",
    "-q",
    "refs/remotes/origin/HEAD",
  ]);
  const candidates = [...new Set([...(originHead ? [originHead] : []), ...BASE_CANDIDATES])];
  let best: { ref: string; ahead: number } | undefined;
  for (const ref of candidates) {
    if (ref === target.branch || ref === `${ORIGIN_PREFIX}${target.branch}`) continue;
    if (!(await refExists(root, ref))) continue;
    const ahead = await commitsAhead(root, ref, target.sha);
    if (Number.isFinite(ahead) && (!best || ahead < best.ahead)) best = { ref, ahead };
  }
  return best?.ref;
}
