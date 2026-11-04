import type { Finding, Review, Severity } from "@crit/schema";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "./db/connection.ts";
import * as t from "./db/schema.ts";
import { reviewFromRow } from "./mappers.ts";

export type HistoryFilter = {
  repoId?: string;
  branch?: string;
  /** Matches scope label substring, e.g. "src/db" or "→ main". */
  scope?: string;
  provider?: string;
  since?: number;
  until?: number;
  limit?: number;
};

export type HistoryRow = {
  review: Review;
  repoName: string;
  /** Visible findings (skeptic-rejected excluded) by severity. */
  severity: Record<Severity, number>;
  outcome: { applied: number; dismissed: number; open: number; filtered: number };
};

const emptySeverity = (): Record<Severity, number> => ({ critical: 0, major: 0, minor: 0, nit: 0 });

/** Reviews newest first, with finding counts by severity and outcome. */
export async function listHistory(db: Db, filter: HistoryFilter = {}): Promise<HistoryRow[]> {
  const conds = [
    filter.repoId ? eq(t.reviews.repoId, filter.repoId) : undefined,
    filter.branch ? eq(t.reviews.branch, filter.branch) : undefined,
    filter.provider ? eq(t.reviews.provider, filter.provider) : undefined,
    filter.scope
      ? sql`lower(${t.reviews.scopeLabel}) like ${`%${filter.scope.toLowerCase()}%`}`
      : undefined,
    filter.since !== undefined ? gte(t.reviews.startedAt, filter.since) : undefined,
    filter.until !== undefined ? lte(t.reviews.startedAt, filter.until) : undefined,
  ];
  const rows = await db
    .select({ review: t.reviews, repoName: t.repos.name })
    .from(t.reviews)
    .innerJoin(t.repos, eq(t.reviews.repoId, t.repos.id))
    .where(and(...conds))
    .orderBy(desc(t.reviews.startedAt), desc(t.reviews.id))
    .limit(filter.limit ?? 100)
    .all();
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.review.id);
  const counts = await db
    .select({
      reviewId: t.findings.reviewId,
      severity: t.findings.severity,
      status: t.findings.status,
      verdict: t.findings.verdict,
      n: sql<number>`count(*)`,
    })
    .from(t.findings)
    .where(inArray(t.findings.reviewId, ids))
    .groupBy(t.findings.reviewId, t.findings.severity, t.findings.status, t.findings.verdict)
    .all();

  const byReview = new Map<string, HistoryRow>(
    rows.map((r) => [
      r.review.id,
      {
        review: reviewFromRow(r.review),
        repoName: r.repoName,
        severity: emptySeverity(),
        outcome: { applied: 0, dismissed: 0, open: 0, filtered: 0 },
      },
    ]),
  );
  for (const c of counts) {
    const row = byReview.get(c.reviewId)!;
    const n = Number(c.n);
    if (c.verdict === "rejected") {
      row.outcome.filtered += n;
      continue;
    }
    row.severity[c.severity as Severity] += n;
    if (c.status === "applied" || c.status === "fixed") row.outcome.applied += n;
    else if (c.status === "dismissed") row.outcome.dismissed += n;
    else if (c.status === "open") row.outcome.open += n;
  }
  return [...byReview.values()];
}

export type Comparison = {
  /** In the older review, gone (or applied) in the newer one. */
  fixed: Finding[];
  /** Only in the newer review. */
  new: Finding[];
  /** In both and still open in the newer one. */
  stillOpen: Finding[];
};

const visible = (f: Finding) => f.verdict !== "rejected";

/** Match findings by fingerprint between an older review `a` and a newer review `b`. */
export function compareFindings(a: Finding[], b: Finding[]): Comparison {
  const older = a.filter(visible);
  const newer = b.filter(visible);
  const inB = new Map(newer.map((f) => [f.fingerprint, f]));
  const inA = new Set(older.map((f) => f.fingerprint));
  const done = (f: Finding) =>
    f.status === "applied" || f.status === "fixed" || f.status === "closed";
  return {
    fixed: older.filter((f) => {
      const later = inB.get(f.fingerprint);
      return !later || done(later) || done(f);
    }),
    new: newer.filter((f) => !inA.has(f.fingerprint)),
    stillOpen: newer.filter((f) => inA.has(f.fingerprint) && f.status === "open"),
  };
}
