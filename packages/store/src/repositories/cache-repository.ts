import type { Db } from "../db/connection.ts";
import { eq, lt } from "drizzle-orm";
import * as t from "../db/schema.ts";
import type { Repositories } from "./repositories-types.ts";

export const createCacheRepository = (db: Db): Repositories["cache"] => ({
  async get(key) {
    return db.select().from(t.cacheEntries).where(eq(t.cacheEntries.key, key)).get();
  },
  async put(entry) {
    const row = { ...entry, createdAt: entry.createdAt ?? Date.now() };
    await db
      .insert(t.cacheEntries)
      .values(row)
      .onConflictDoUpdate({ target: t.cacheEntries.key, set: row });
  },
  async pruneOlderThan(before) {
    const rows = await db
      .select({ key: t.cacheEntries.key })
      .from(t.cacheEntries)
      .where(lt(t.cacheEntries.createdAt, before))
      .all();
    if (rows.length > 0)
      await db.delete(t.cacheEntries).where(lt(t.cacheEntries.createdAt, before));
    return rows.length;
  },
});
