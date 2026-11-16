import type { Finding, Fix } from "@crit/schema";
import type { Repositories } from "@crit/store";
import { z } from "zod";
import { diffPath, parseUnifiedDiff } from "../diff.ts";
import { type GhRunner, runGh } from "./gh-runner.ts";
import { type FixSuggestion, fixSuggestions } from "./fix-suggestion.ts";
import { type InlineFinding, placeFindings } from "./place-findings.ts";
import {
  fetchPostedFingerprints,
  fetchPrDiff,
  findPullRequest,
  type PullRequest,
  issuesPath,
  pullsPath,
} from "./pull-request.ts";
import { findingComment, partComment, reviewBody } from "./review-comment.ts";

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

const lineSpan = (range: { start: number; end: number }) => ({
  line: range.end,
  side: RIGHT_SIDE,
  ...(range.start < range.end ? { start_line: range.start, start_side: RIGHT_SIDE } : {}),
});

const toComments = (
  { finding, range }: InlineFinding,
  fix: Fix | undefined,
  suggestions: FixSuggestion[],
) => {
  const [first, ...rest] = suggestions;
  return [
    {
      path: finding.file,
      ...lineSpan(first?.range ?? range),
      body: findingComment(finding, fix, first),
    },
    ...rest.map((suggestion, index) => ({
      path: finding.file,
      ...lineSpan(suggestion.range),
      body: partComment(finding, index + 2, suggestions.length, suggestion),
    })),
  ];
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
  const activeFixes = new Map(fixes.filter((fix) => fix.active).map((f) => [f.findingId, f]));
  const suggestionsOf = (finding: Finding) => {
    const fix = activeFixes.get(finding.id);
    return fix ? fixSuggestions(fix.patch, finding.file, prFiles) : [];
  };
  const placed = placeFindings(fresh, prFiles);
  const rescued = placed.outside.filter((finding) => suggestionsOf(finding).length > 0);
  const inline: InlineFinding[] = [
    ...placed.inline,
    ...rescued.map((finding) => ({ finding, range: suggestionsOf(finding)[0]!.range })),
  ];
  const outside = placed.outside.filter((finding) => !rescued.includes(finding));
  const result: PrPublishResult = {
    pr,
    inline: inline.length,
    outsideDiff: outside.length,
    alreadyPosted: eligible.length - fresh.length,
    isHeadStale: review.headSha !== null && review.headSha !== pr.headSha,
  };
  if (fresh.length === 0) return result;
  const post = (path: string, body: object) =>
    runGh(
      gh,
      root,
      ["api", "--hostname", pr.host, "--method", "POST", path, "--input", "-"],
      JSON.stringify(body),
    );
  let url: string | undefined;
  if (inline.length > 0) {
    const response = await post(`${pullsPath(pr)}/reviews`, {
      commit_id: pr.headSha,
      event: REVIEW_EVENT,
      body: reviewBody(inline.length, []),
      comments: inline.flatMap((placed) =>
        toComments(placed, activeFixes.get(placed.finding.id), suggestionsOf(placed.finding)),
      ),
    });
    url = PostedReview.parse(JSON.parse(response)).html_url;
  }
  const inDiff = new Set(prFiles.map((file) => diffPath(file)));
  for (const finding of outside) {
    const body = findingComment(finding, activeFixes.get(finding.id));
    const response = inDiff.has(finding.file)
      ? await post(`${pullsPath(pr)}/comments`, {
          commit_id: pr.headSha,
          path: finding.file,
          subject_type: "file",
          body,
        })
      : await post(`${issuesPath(pr)}/comments`, {
          body: `\`${finding.file}:${finding.range.start}\`\n\n${body}`,
        });
    url ??= PostedReview.parse(JSON.parse(response)).html_url;
  }
  return { ...result, ...(url ? { url } : {}) };
}
