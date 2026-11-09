import { formatTokens, shortId } from "@crit/schema";
import { listHistory, type SqliteStore } from "@crit/store";

export async function summaryLine(
  store: SqliteStore,
  reviewId: string,
): Promise<string | undefined> {
  const review = await store.reviews.get(reviewId);
  if (!review) return undefined;
  const row = (await listHistory(store.db, { repoId: review.repoId, limit: 20 })).find(
    (historyRow) => historyRow.review.id === reviewId,
  );
  if (!row) return undefined;
  const findings = await store.findings.listByReview(reviewId);
  const shown = findings.filter(
    (finding) => finding.verdict !== "rejected" && finding.status !== "dismissed",
  );
  const selected = shown.filter((f) => f.selected).length;
  const tokens = row.tokens.effective > 0 ? ` · ~${formatTokens(row.tokens.effective)} tokens` : "";
  const state = review.status === "partial" ? " (stopped early)" : "";
  const id = shortId(reviewId);
  return `crit review ${id}${state} · ${review.scopeLabel} · ${shown.length} findings, ${selected} selected${tokens} · crit open ${id} to come back\n`;
}
