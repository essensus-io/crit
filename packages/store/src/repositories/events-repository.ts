import type { Db } from "../db/connection.ts";
import { newId } from "@crit/schema";
import { and, asc, eq } from "drizzle-orm";
import * as t from "../db/schema.ts";
import type { Repositories } from "./repositories-types.ts";

export const createEventsRepository = (db: Db): Repositories["events"] => ({
  async append(reviewId, type, payload) {
    const id = newId();
    await db.insert(t.events).values({
      id,
      reviewId,
      type,
      payload: JSON.stringify(payload ?? null),
      createdAt: Date.now(),
    });
    return id;
  },
  async list(reviewId, type) {
    const where = type
      ? and(eq(t.events.reviewId, reviewId), eq(t.events.type, type))
      : eq(t.events.reviewId, reviewId);
    const rows = await db.select().from(t.events).where(where).orderBy(asc(t.events.id)).all();
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      payload: JSON.parse(row.payload),
      createdAt: row.createdAt,
    }));
  },
});
