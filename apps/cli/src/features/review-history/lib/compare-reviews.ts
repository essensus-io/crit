import { type Review } from "@crit/schema";
import { compareFindings, type Comparison, type SqliteStore } from "@crit/store";

export async function compareReviews(
  store: SqliteStore,
  a: Review,
  b: Review,
): Promise<Comparison & { older: Review; newer: Review }> {
  const [older, newer] = a.startedAt <= b.startedAt ? [a, b] : [b, a];
  const comparison = compareFindings(
    await store.findings.listByReview(older.id),
    await store.findings.listByReview(newer.id),
  );
  return { ...comparison, older, newer };
}
