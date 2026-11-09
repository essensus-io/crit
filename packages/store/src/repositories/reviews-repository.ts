import type { Db } from "../db/connection.ts";
import { and, desc, eq, inArray, like, lt, ne, or, sql } from "drizzle-orm";
import * as t from "../db/schema.ts";
import { reviewFromRow, reviewToRow } from "../mappers.ts";
import type { Repositories } from "./repositories-types.ts";
import { must } from "./must.ts";

export const createReviewsRepository = (db: Db): Repositories["reviews"] => {
  const reviews: Repositories["reviews"] = {
    async create(review) {
      await db.insert(t.reviews).values(reviewToRow(review));
      return review;
    },
    async get(id) {
      const row = await db.select().from(t.reviews).where(eq(t.reviews.id, id)).get();
      return row ? reviewFromRow(row) : undefined;
    },
    async resolve(ref, repoId) {
      const needle = ref.toLowerCase();
      const match = or(
        eq(t.reviews.id, needle),
        like(t.reviews.id, `${needle}%`),
        needle.length <= 12 ? like(t.reviews.id, `%${needle}`) : undefined,
      );
      const rows = await db
        .select()
        .from(t.reviews)
        .where(repoId ? and(eq(t.reviews.repoId, repoId), match) : match)
        .orderBy(desc(t.reviews.startedAt))
        .all();
      const exact = rows.find((row) => row.id === needle);
      return (exact ? [exact] : rows).map(reviewFromRow);
    },
    async latest(repoId) {
      const row = await db
        .select()
        .from(t.reviews)
        .where(eq(t.reviews.repoId, repoId))
        .orderBy(desc(t.reviews.startedAt), desc(t.reviews.id))
        .limit(1)
        .get();
      return row ? reviewFromRow(row) : undefined;
    },
    async update(id, patch) {
      const current = must(await reviews.get(id), `review ${id}`);
      const next = { ...current, ...patch };
      await db.update(t.reviews).set(reviewToRow(next)).where(eq(t.reviews.id, id));
      return next;
    },
    async markSuperseded(review) {
      const rows = await db
        .select({ id: t.reviews.id })
        .from(t.reviews)
        .where(
          and(
            eq(t.reviews.repoId, review.repoId),
            eq(t.reviews.scopeLabel, review.scopeLabel),
            review.branch === null
              ? sql`${t.reviews.branch} IS NULL`
              : eq(t.reviews.branch, review.branch),
            ne(t.reviews.id, review.id),
            lt(t.reviews.startedAt, review.startedAt),
            inArray(t.reviews.status, ["completed", "failed", "cancelled"]),
          ),
        )
        .all();
      const ids = rows.map((row) => row.id);
      if (ids.length > 0) {
        await db
          .update(t.reviews)
          .set({ status: "superseded", supersededBy: review.id })
          .where(inArray(t.reviews.id, ids));
      }
      return ids;
    },
    async delete(id) {
      await db.delete(t.reviews).where(eq(t.reviews.id, id));
    },
    async deleteOlderThan(before, repoId) {
      const where = repoId
        ? and(lt(t.reviews.startedAt, before), eq(t.reviews.repoId, repoId))
        : lt(t.reviews.startedAt, before);
      const rows = await db.select({ id: t.reviews.id }).from(t.reviews).where(where).all();
      if (rows.length > 0) await db.delete(t.reviews).where(where);
      return rows.map((row) => row.id);
    },
  };
  return reviews;
};
