import type { PrPublishResult } from "@crit/core";
import { plural } from "@/shared/lib/format.ts";

export const describePrPost = (result: PrPublishResult): string => {
  const { pr } = result;
  const posted = result.inline + result.outsideDiff;
  const parts: string[] = [];
  if (result.url)
    parts.push(
      `Posted ${plural(posted, "finding")} to PR #${pr.number}${result.outsideDiff ? ` (${result.outsideDiff} outside the diff, in the review text)` : ""}: ${result.url}`,
    );
  else if (result.alreadyPosted)
    parts.push(`Nothing new for PR #${pr.number}: ${result.alreadyPosted} already posted.`);
  else parts.push(`Nothing to post to PR #${pr.number}.`);
  if (result.url && result.alreadyPosted) parts.push(`${result.alreadyPosted} already posted.`);
  if (result.isHeadStale)
    parts.push("The PR head differs from the reviewed commit; push your branch to line them up.");
  return parts.join(" ");
};
