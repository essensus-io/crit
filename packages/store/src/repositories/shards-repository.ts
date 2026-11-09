import type { Db } from "../db/connection.ts";
import { asc, eq } from "drizzle-orm";
import * as t from "../db/schema.ts";
import { shardFromRow, shardToRow } from "../mappers.ts";
import type { Repositories } from "./repositories-types.ts";
import { must } from "./must.ts";

export const createShardsRepository = (db: Db): Repositories["shards"] => ({
  async create(shard) {
    await db.insert(t.shards).values(shardToRow(shard));
    return shard;
  },
  async update(id, patch) {
    const row = must(
      await db.select().from(t.shards).where(eq(t.shards.id, id)).get(),
      `shard ${id}`,
    );
    const next = { ...shardFromRow(row), ...patch };
    await db.update(t.shards).set(shardToRow(next)).where(eq(t.shards.id, id));
    return next;
  },
  async listByReview(reviewId) {
    const rows = await db
      .select()
      .from(t.shards)
      .where(eq(t.shards.reviewId, reviewId))
      .orderBy(asc(t.shards.id))
      .all();
    return rows.map(shardFromRow);
  },
});
