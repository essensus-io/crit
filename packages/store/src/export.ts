import { REVIEW_EXPORT_VERSION, ReviewExport } from "@crit/schema";
import type { BatchItem } from "drizzle-orm/batch";
import { eq } from "drizzle-orm";
import * as t from "./db/schema.ts";
import { findingToRow, fixToRow, reviewToRow, shardToRow } from "./mappers.ts";
import type { SqliteStore } from "./store.ts";

/** The versioned JSON document for one review. */
export async function exportReview(store: SqliteStore, reviewId: string): Promise<ReviewExport> {
  const review = await store.reviews.get(reviewId);
  if (!review) throw new Error(`crit: review ${reviewId} not found`);
  const repo = await store.repos.get(review.repoId);
  if (!repo) throw new Error(`crit: repo ${review.repoId} not found`);
  return ReviewExport.parse({
    format: "crit.review",
    version: REVIEW_EXPORT_VERSION,
    exportedAt: Date.now(),
    repo,
    review,
    shards: await store.shards.listByReview(reviewId),
    findings: await store.findings.listByReview(reviewId),
    fixes: await store.fixes.listByReview(reviewId),
    messages: await store.messages.listByReview(reviewId),
  });
}

/**
 * Import a review document. The repo is matched by root path (or created with
 * the document's id). Replaces any existing review with the same id. Atomic.
 */
export async function importReview(store: SqliteStore, input: unknown): Promise<ReviewExport> {
  const doc = ReviewExport.parse(input);
  const { db } = store;
  const existingRepo = await store.repos.getByRoot(doc.repo.root);
  const repoId = existingRepo?.id ?? doc.repo.id;
  const review = { ...doc.review, repoId };

  const ops: BatchItem<"sqlite">[] = [];
  if (!existingRepo) {
    ops.push(
      db.insert(t.repos).values({
        id: repoId,
        rootPath: doc.repo.root,
        remoteUrl: doc.repo.remoteUrl,
        name: doc.repo.name,
        createdAt: doc.review.startedAt,
      }),
    );
  }
  ops.push(db.delete(t.reviews).where(eq(t.reviews.id, review.id)));
  ops.push(db.insert(t.reviews).values(reviewToRow(review)));
  for (const s of doc.shards) ops.push(db.insert(t.shards).values(shardToRow(s)));
  for (const f of doc.findings) ops.push(db.insert(t.findings).values(findingToRow(f)));
  for (const f of doc.fixes) ops.push(db.insert(t.fixes).values(fixToRow(f)));
  for (const m of doc.messages) ops.push(db.insert(t.messages).values(m));
  await db.batch(ops as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return { ...doc, review, repo: { ...doc.repo, id: repoId } };
}
