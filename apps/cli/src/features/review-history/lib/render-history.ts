import { shortId } from "@crit/schema";
import { type HistoryRow } from "@crit/store";
import { colors } from "@/shared/lib/colors.ts";
import { table } from "@/shared/lib/table.ts";
import { truncate } from "@/shared/lib/text.ts";
import { when } from "@/shared/lib/format.ts";
import { outcomeOf, severitySummary, tokensLabel } from "./history-labels.ts";

export function renderHistory(
  rows: HistoryRow[],
  opts: { now: number; color: boolean; allRepos?: boolean; cursor?: number },
): string {
  const c = colors(opts.color);
  const head = [
    "",
    c.dim("ID"),
    c.dim("WHEN"),
    ...(opts.allRepos ? [c.dim("REPO")] : []),
    c.dim("SCOPE"),
    c.dim("PROVIDER"),
    c.dim("FINDINGS"),
    c.dim("TOKENS"),
    c.dim("OUTCOME"),
  ];
  const body = rows.map((r, i) => {
    const scope = r.review.scopeLabel;
    return [
      i === opts.cursor ? "›" : " ",
      shortId(r.review.id),
      when(r.review.startedAt, opts.now),
      ...(opts.allRepos ? [r.repoName] : []),
      truncate(scope, 30),
      r.review.provider,
      severitySummary(r),
      tokensLabel(r),
      outcomeOf(r),
    ];
  });
  return `${table([head, ...body])}\n\n  ${c.dim("C critical · M major · m minor · n nit")}\n`;
}
