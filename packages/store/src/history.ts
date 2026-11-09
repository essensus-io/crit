import {
  addUsage,
  effectiveTokens,
  emptyUsage,
  type Finding,
  type Review,
  type Severity,
  type TokenUsage,
} from "@crit/schema";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "./db/connection.ts";
import * as t from "./db/schema.ts";
import { reviewFromRow } from "./mappers.ts";

export type HistoryFilter = {
  repoId?: string;
  branch?: string;
  scope?: string;
  provider?: string;
  since?: number;
  until?: number;
  limit?: number;
};

export type HistoryRow = {
  review: Review;
  repoName: string;
  severity: Record<Severity, number>;
  outcome: { applied: number; dismissed: number; open: number; filtered: number };
  tokens: TokenUsage & { effective: number };
};

const emptySeverity = (): Record<Severity, number> => ({ critical: 0, major: 0, minor: 0, nit: 0 });

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

  const ids = rows.map((row) => row.review.id);
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
    rows.map((row) => [
      row.review.id,
      {
        review: reviewFromRow(row.review),
        repoName: row.repoName,
        severity: emptySeverity(),
        outcome: { applied: 0, dismissed: 0, open: 0, filtered: 0 },
        tokens: { ...emptyUsage(), effective: 0 },
      },
    ]),
  );
  const shardTokens = await db
    .select({
      reviewId: t.shards.reviewId,
      input: sql<number>`coalesce(sum(${t.shards.inputTokens}), 0)`,
      cached: sql<number>`coalesce(sum(${t.shards.cachedTokens}), 0)`,
      output: sql<number>`coalesce(sum(${t.shards.outputTokens}), 0)`,
    })
    .from(t.shards)
    .where(inArray(t.shards.reviewId, ids))
    .groupBy(t.shards.reviewId)
    .all();
  const usageEvents = await db
    .select({ reviewId: t.events.reviewId, payload: t.events.payload })
    .from(t.events)
    .where(and(inArray(t.events.reviewId, ids), eq(t.events.type, "usage")))
    .all();
  const add = (reviewId: string, u: Partial<TokenUsage>) => {
    const row = byReview.get(reviewId)!;
    Object.assign(row.tokens, addUsage(row.tokens, u));
    row.tokens.effective = effectiveTokens(row.tokens);
  };
  for (const shardToken of shardTokens)
    add(shardToken.reviewId, {
      inputTokens: Number(shardToken.input),
      cachedInputTokens: Number(shardToken.cached),
      outputTokens: Number(shardToken.output),
    });
  for (const usageEvent of usageEvents)
    add(usageEvent.reviewId, JSON.parse(usageEvent.payload) as Partial<TokenUsage>);
  for (const count of counts) {
    const row = byReview.get(count.reviewId)!;
    const n = Number(count.n);
    if (count.verdict === "rejected") {
      row.outcome.filtered += n;
      continue;
    }
    row.severity[count.severity as Severity] += n;
    if (count.status === "applied" || count.status === "fixed") row.outcome.applied += n;
    else if (count.status === "dismissed") row.outcome.dismissed += n;
    else if (count.status === "open") row.outcome.open += n;
  }
  return [...byReview.values()];
}

export type Comparison = {
  fixed: Finding[];
  new: Finding[];
  stillOpen: Finding[];
};

const visible = (f: Finding) => f.verdict !== "rejected";

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
