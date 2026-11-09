import type { Db } from "../db/connection.ts";
import { type Finding } from "@crit/schema";
import { asc, eq } from "drizzle-orm";
import * as t from "../db/schema.ts";
import { findingFromRow, findingToRow } from "../mappers.ts";
import type { Repositories } from "./repositories-types.ts";
import { must } from "./must.ts";

export const createFindingsRepository = (db: Db): Repositories["findings"] => {
  const findings: Repositories["findings"] = {
    async create(finding) {
      await db.insert(t.findings).values(findingToRow(finding));
      return finding;
    },
    async get(id) {
      const row = await db.select().from(t.findings).where(eq(t.findings.id, id)).get();
      return row ? findingFromRow(row) : undefined;
    },
    async listByReview(reviewId) {
      const rows = await db
        .select()
        .from(t.findings)
        .where(eq(t.findings.reviewId, reviewId))
        .orderBy(asc(t.findings.file), asc(t.findings.rangeStart), asc(t.findings.id))
        .all();
      return rows.map(findingFromRow);
    },
    async update(id, patch) {
      const current = must(await findings.get(id), `finding ${id}`);
      const next: Finding = { ...current, ...patch };
      await db.update(t.findings).set(findingToRow(next)).where(eq(t.findings.id, id));
      return next;
    },
    async reassign(id, reviewId) {
      await db.update(t.findings).set({ reviewId }).where(eq(t.findings.id, id));
    },
    async delete(id) {
      await db.delete(t.findings).where(eq(t.findings.id, id));
    },
  };
  return findings;
};
