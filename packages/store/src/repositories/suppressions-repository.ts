import type { Db } from "../db/connection.ts";
import { newId, type Suppression } from "@crit/schema";
import { and, eq } from "drizzle-orm";
import * as t from "../db/schema.ts";
import { suppressionFromRow } from "../mappers.ts";
import type { Repositories } from "./repositories-types.ts";

export const createSuppressionsRepository = (db: Db): Repositories["suppressions"] => ({
  async add(repoId, fingerprint, reason) {
    const s: Suppression = { id: newId(), repoId, fingerprint, reason, createdAt: Date.now() };
    await db
      .insert(t.suppressions)
      .values(s)
      .onConflictDoUpdate({
        target: [t.suppressions.repoId, t.suppressions.fingerprint],
        set: { reason, createdAt: s.createdAt },
      });
    return s;
  },
  async list(repoId) {
    const rows = await db
      .select()
      .from(t.suppressions)
      .where(eq(t.suppressions.repoId, repoId))
      .all();
    return rows.map(suppressionFromRow);
  },
  async remove(repoId, fingerprint) {
    await db
      .delete(t.suppressions)
      .where(and(eq(t.suppressions.repoId, repoId), eq(t.suppressions.fingerprint, fingerprint)));
  },
});
