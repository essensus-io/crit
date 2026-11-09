import type { Db } from "../db/connection.ts";
import { type Message, newId } from "@crit/schema";
import { asc, eq } from "drizzle-orm";
import * as t from "../db/schema.ts";
import { messageFromRow } from "../mappers.ts";
import type { Repositories } from "./repositories-types.ts";

export const createMessagesRepository = (db: Db): Repositories["messages"] => ({
  async add(findingId, role, body) {
    const m: Message = { id: newId(), findingId, role, body, createdAt: Date.now() };
    await db.insert(t.messages).values(m);
    return m;
  },
  async listByFinding(findingId) {
    const rows = await db
      .select()
      .from(t.messages)
      .where(eq(t.messages.findingId, findingId))
      .orderBy(asc(t.messages.id))
      .all();
    return rows.map(messageFromRow);
  },
  async listByReview(reviewId) {
    const rows = await db
      .select({ m: t.messages })
      .from(t.messages)
      .innerJoin(t.findings, eq(t.messages.findingId, t.findings.id))
      .where(eq(t.findings.reviewId, reviewId))
      .orderBy(asc(t.messages.id))
      .all();
    return rows.map((row) => messageFromRow(row.m));
  },
});
