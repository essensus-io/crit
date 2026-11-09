import type { Db } from "../db/connection.ts";
import { eq } from "drizzle-orm";
import * as t from "../db/schema.ts";
import type { Repositories } from "./repositories-types.ts";

export const createKvRepository = (db: Db): Repositories["kv"] => ({
  async get(key) {
    const row = await db.select().from(t.kv).where(eq(t.kv.key, key)).get();
    return row?.value;
  },
  async set(key, value) {
    const row = { key, value, createdAt: Date.now() };
    await db.insert(t.kv).values(row).onConflictDoUpdate({ target: t.kv.key, set: row });
  },
});
