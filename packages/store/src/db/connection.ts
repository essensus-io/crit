import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { MIGRATIONS } from "./migrations.gen.ts";
import * as schema from "./schema.ts";

export type Db = SqliteRemoteDatabase<typeof schema>;

export type Connection = {
  db: Db;
  raw: DatabaseSync;
  close(): void;
};

type Method = "run" | "all" | "values" | "get";

function exec(
  raw: DatabaseSync,
  sql: string,
  params: unknown[],
  method: Method,
): { rows: unknown } {
  const stmt = raw.prepare(sql);
  const args = params as SQLInputValue[];
  if (method === "run") {
    stmt.run(...args);
    return { rows: [] };
  }
  stmt.setReturnArrays(true);
  if (method === "get") return { rows: stmt.get(...args) };
  return { rows: stmt.all(...args) };
}

export function openDatabase(path: string = ":memory:"): Connection {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("PRAGMA busy_timeout = 5000");
  if (path !== ":memory:") raw.exec("PRAGMA journal_mode = WAL");

  const db = drizzle(
    async (sql, params, method) => exec(raw, sql, params, method) as { rows: unknown[][] },
    async (queries) => {
      raw.exec("BEGIN IMMEDIATE");
      try {
        const results = queries.map(
          (q) => exec(raw, q.sql, q.params, q.method) as { rows: unknown[][] },
        );
        raw.exec("COMMIT");
        return results;
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      }
    },
    { schema },
  );

  migrate(raw);
  return { db, raw, close: () => raw.close() };
}

export function migrate(raw: DatabaseSync): string[] {
  raw.exec(
    "CREATE TABLE IF NOT EXISTS crit_migrations (tag text PRIMARY KEY NOT NULL, applied_at integer NOT NULL)",
  );
  const applied = new Set(
    (raw.prepare("SELECT tag FROM crit_migrations").all() as { tag: string }[]).map((r) => r.tag),
  );
  const done: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.tag)) continue;
    raw.exec("BEGIN IMMEDIATE");
    try {
      for (const s of m.statements) raw.exec(s);
      raw
        .prepare("INSERT INTO crit_migrations (tag, applied_at) VALUES (?, ?)")
        .run(m.tag, Date.now());
      raw.exec("COMMIT");
      done.push(m.tag);
    } catch (err) {
      raw.exec("ROLLBACK");
      throw new Error(`crit: database migration ${m.tag} failed: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }
  return done;
}
