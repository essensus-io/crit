import type { Finding, Fix } from "@crit/schema";
import type { Repositories } from "@crit/store";
import { z } from "zod";
import { type ParsedFile, parseUnifiedDiff } from "../diff.ts";
import { type GhRunner, runGh } from "./gh-runner.ts";
import { fixSuggestion } from "./fix-suggestion.ts";
import { type InlineFinding, placeFindings } from "./place-findings.ts";
import {
  fetchPostedFingerprints,
  fetchPrDiff,
  findPullRequest,
  type PullRequest,
  pullsPath,
} from "./pull-request.ts";
import { findingComment, reviewBody } from "./review-comment.ts";

const REVIEW_EVENT = "COMMENT";
const RIGHT_SIDE = "RIGHT";
const PostedReview = z.object({ html_url: z.string() });

export type PrPublishInput = {
  gh: GhRunner;
  store: Repositories;
  root: string;
  reviewId: string;
  findingIds?: string[];
  pr?: PullRequest;
};

export type PrPublishResult = {
  pr: PullRequest;
  url?: string;
  inline: number;
  outsideDiff: number;
  alreadyPosted: number;
  isHeadStale: boolean;
};

const isEligible = (finding: Finding, findingIds: string[] | undefined) =>
  finding.status === "open" &&
  finding.verdict !== "rejected" &&
  (findingIds === undefined || findingIds.includes(finding.id));

const byPosition = (a: Finding, b: Finding) =>
  a.file.localeCompare(b.file) || a.range.start - b.range.start;

const toComment = (
  { finding, range }: InlineFinding,
  fix: Fix | undefined,
  prFiles: ParsedFile[],
) => {
  const suggestion = fix ? fixSuggestion(fix.patch, finding.file, prFiles) : undefined;
  const where = suggestion?.range ?? range;
  return {
    path: finding.file,
    line: where.end,
    side: RIGHT_SIDE,
    body: findingComment(finding, fix, suggestion),
    ...(where.start < where.end ? { start_line: where.start, start_side: RIGHT_SIDE } : {}),
  };
};

export async function publishPrReview(input: PrPublishInput): Promise<PrPublishResult> {
  const { gh, store, root, reviewId, findingIds } = input;
  const review = await store.reviews.get(reviewId);
  if (!review) throw new Error(`crit: review ${reviewId} not found`);
  const pr = input.pr ?? (await findPullRequest(gh, root, review.branch));
  const [diff, posted, findings, fixes] = await Promise.all([
    fetchPrDiff(gh, root, pr),
    fetchPostedFingerprints(gh, root, pr),
    store.findings.listByReview(reviewId),
    store.fixes.listByReview(reviewId),
  ]);
  const eligible = findings.filter((finding) => isEligible(finding, findingIds)).sort(byPosition);
  const fresh = eligible.filter((finding) => !posted.has(finding.fingerprint));
  const prFiles = parseUnifiedDiff(diff);
  const { inline, outside } = placeFindings(fresh, prFiles);
  const result: PrPublishResult = {
    pr,
    inline: inline.length,
    outsideDiff: outside.length,
    alreadyPosted: eligible.length - fresh.length,
    isHeadStale: review.headSha !== null && review.headSha !== pr.headSha,
  };
  if (fresh.length === 0) return result;
  const activeFixes = new Map(fixes.filter((fix) => fix.active).map((f) => [f.findingId, f]));
  const payload = {
    commit_id: pr.headSha,
    event: REVIEW_EVENT,
    body: reviewBody(inline.length, outside),
    comments: inline.map((placed) =>
      toComment(placed, activeFixes.get(placed.finding.id), prFiles),
    ),
  };
  const response = await runGh(
    gh,
    root,
    ["api", "--hostname", pr.host, "--method", "POST", `${pullsPath(pr)}/reviews`, "--input", "-"],
    JSON.stringify(payload),
  );
  return { ...result, url: PostedReview.parse(JSON.parse(response)).html_url };
}
