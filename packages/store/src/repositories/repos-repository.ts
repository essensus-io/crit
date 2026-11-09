import type { Db } from "../db/connection.ts";
import { newId, type Repo } from "@crit/schema";
import { asc, eq } from "drizzle-orm";
import * as t from "../db/schema.ts";
import { repoFromRow } from "../mappers.ts";
import type { Repositories } from "./repositories-types.ts";

export const createReposRepository = (db: Db): Repositories["repos"] => {
  const repos: Repositories["repos"] = {
    async upsert({ root, remoteUrl, name }) {
      const existing = await repos.getByRoot(root);
      if (existing) {
        if (existing.remoteUrl !== remoteUrl || existing.name !== name) {
          await db.update(t.repos).set({ remoteUrl, name }).where(eq(t.repos.id, existing.id));
        }
        return { ...existing, remoteUrl, name };
      }
      const repo: Repo = { id: newId(), root, remoteUrl, name };
      await db
        .insert(t.repos)
        .values({ id: repo.id, rootPath: root, remoteUrl, name, createdAt: Date.now() });
      return repo;
    },
    async get(id) {
      const row = await db.select().from(t.repos).where(eq(t.repos.id, id)).get();
      return row ? repoFromRow(row) : undefined;
    },
    async getByRoot(root) {
      const row = await db.select().from(t.repos).where(eq(t.repos.rootPath, root)).get();
      return row ? repoFromRow(row) : undefined;
    },
    async list() {
      const rows = await db.select().from(t.repos).orderBy(asc(t.repos.name)).all();
      return rows.map(repoFromRow);
    },
  };
  return repos;
};
