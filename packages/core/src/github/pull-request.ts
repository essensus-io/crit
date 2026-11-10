import { z } from "zod";
import { currentBranch } from "../git.ts";
import { GhError, type GhRunner, runGh } from "./gh-runner.ts";
import { fingerprintsIn } from "./review-comment.ts";

const PrView = z.object({
  number: z.number().int(),
  url: z.string(),
  headRefOid: z.string(),
  state: z.string(),
});

const OPEN_STATE = "OPEN";
const NO_PULL_REQUEST = /no pull requests? found/i;

export type PullRequest = {
  number: number;
  url: string;
  headSha: string;
  host: string;
  repository: string;
};

const noPullRequest = (branch: string | undefined) =>
  new GhError(
    `crit: no open pull request for ${branch ? `branch ${branch}` : "this branch"}. Push it and run \`gh pr create\`.`,
  );

export async function findPullRequest(
  gh: GhRunner,
  root: string,
  branch?: string | null,
): Promise<PullRequest> {
  const here = await currentBranch(root);
  const other = branch && branch !== here ? branch : undefined;
  const args = ["pr", "view", ...(other ? [other] : []), "--json", "number,url,headRefOid,state"];
  const result = await gh(root, args);
  if (result.exitCode !== 0 && NO_PULL_REQUEST.test(result.stderr))
    throw noPullRequest(other ?? here);
  if (result.exitCode !== 0) throw new GhError(`crit: gh pr view failed: ${result.stderr.trim()}`);
  const view = PrView.parse(JSON.parse(result.stdout));
  if (view.state !== OPEN_STATE) throw noPullRequest(other ?? here);
  const { host, pathname } = new URL(view.url);
  const [owner, repo] = pathname.split("/").filter(Boolean);
  return {
    number: view.number,
    url: view.url,
    headSha: view.headRefOid,
    host,
    repository: `${owner}/${repo}`,
  };
}

export const pullsPath = (pr: PullRequest) => `repos/${pr.repository}/pulls/${pr.number}`;

export const fetchPrDiff = (gh: GhRunner, root: string, pr: PullRequest) =>
  runGh(gh, root, ["pr", "diff", String(pr.number), "--color", "never"]);

const postedBodies = (gh: GhRunner, root: string, pr: PullRequest, resource: string) =>
  runGh(gh, root, [
    "api",
    "--hostname",
    pr.host,
    "--paginate",
    "--jq",
    ".[].body",
    `${pullsPath(pr)}/${resource}`,
  ]);

export async function fetchPostedFingerprints(
  gh: GhRunner,
  root: string,
  pr: PullRequest,
): Promise<Set<string>> {
  const bodies = await Promise.all([
    postedBodies(gh, root, pr, "comments"),
    postedBodies(gh, root, pr, "reviews"),
  ]);
  return new Set(bodies.flatMap(fingerprintsIn));
}
