import type { Db } from "../db/connection.ts";
import { type Fix } from "@crit/schema";
import { and, asc, eq } from "drizzle-orm";
import * as t from "../db/schema.ts";
import { fixFromRow, fixToRow } from "../mappers.ts";
import type { Repositories } from "./repositories-types.ts";
import { must } from "./must.ts";

export const createFixesRepository = (db: Db): Repositories["fixes"] => {
  const fixes: Repositories["fixes"] = {
    async create(fix) {
      if (fix.active) {
        await db.batch([
          db.update(t.fixes).set({ active: false }).where(eq(t.fixes.findingId, fix.findingId)),
          db.insert(t.fixes).values(fixToRow(fix)),
        ]);
      } else {
        await db.insert(t.fixes).values(fixToRow(fix));
      }
      return fix;
    },
    async get(id) {
      const row = await db.select().from(t.fixes).where(eq(t.fixes.id, id)).get();
      return row ? fixFromRow(row) : undefined;
    },
    async listByFinding(findingId) {
      const rows = await db
        .select()
        .from(t.fixes)
        .where(eq(t.fixes.findingId, findingId))
        .orderBy(asc(t.fixes.createdAt), asc(t.fixes.id))
        .all();
      return rows.map(fixFromRow);
    },
    async listByReview(reviewId) {
      const rows = await db
        .select({ fix: t.fixes })
        .from(t.fixes)
        .innerJoin(t.findings, eq(t.fixes.findingId, t.findings.id))
        .where(eq(t.findings.reviewId, reviewId))
        .orderBy(asc(t.fixes.id))
        .all();
      return rows.map((r) => fixFromRow(r.fix));
    },
    async active(findingId) {
      const row = await db
        .select()
        .from(t.fixes)
        .where(and(eq(t.fixes.findingId, findingId), eq(t.fixes.active, true)))
        .get();
      return row ? fixFromRow(row) : undefined;
    },
    async setActive(id) {
      const fix = must(await fixes.get(id), `fix ${id}`);
      await db.batch([
        db.update(t.fixes).set({ active: false }).where(eq(t.fixes.findingId, fix.findingId)),
        db.update(t.fixes).set({ active: true }).where(eq(t.fixes.id, id)),
      ]);
    },
    async update(id, patch) {
      const current = must(await fixes.get(id), `fix ${id}`);
      const next: Fix = { ...current, ...patch };
      await db.update(t.fixes).set(fixToRow(next)).where(eq(t.fixes.id, id));
      return next;
    },
  };
  return fixes;
};
