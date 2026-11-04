import {
  type Finding,
  type Fix,
  type Message,
  type MessageRole,
  newId,
  type Repo,
  type Review,
  type Shard,
  type Suppression,
} from "@crit/schema";
import { and, asc, desc, eq, inArray, like, lt, ne, or, sql } from "drizzle-orm";
import { type Connection, type Db, openDatabase } from "./db/connection.ts";
import * as t from "./db/schema.ts";
import {
  findingFromRow,
  findingToRow,
  fixFromRow,
  fixToRow,
  messageFromRow,
  repoFromRow,
  reviewFromRow,
  reviewToRow,
  shardFromRow,
  shardToRow,
  suppressionFromRow,
} from "./mappers.ts";

export type ReviewPatch = Partial<Omit<Review, "id" | "repoId">>;
export type ShardPatch = Partial<Omit<Shard, "id" | "reviewId">>;
export type FindingPatch = Partial<Omit<Finding, "id" | "reviewId">>;
export type FixPatch = Partial<Omit<Fix, "id" | "findingId">>;

export type CacheEntry = {
  key: string;
  reviewId: string | null;
  value: string;
  transcriptPath: string | null;
  createdAt: number;
};

/**
 * Every read and write goes through these repositories. A Postgres store would
 * implement the same interface; nothing outside this package touches SQL.
 */
export interface Repositories {
  repos: {
    upsert(input: { root: string; remoteUrl: string | null; name: string }): Promise<Repo>;
    get(id: string): Promise<Repo | undefined>;
    getByRoot(root: string): Promise<Repo | undefined>;
    list(): Promise<Repo[]>;
  };
  reviews: {
    create(review: Review): Promise<Review>;
    get(id: string): Promise<Review | undefined>;
    /** Full id, id prefix, or the 4-char short id shown in history. */
    resolve(ref: string, repoId?: string): Promise<Review[]>;
    latest(repoId: string): Promise<Review | undefined>;
    update(id: string, patch: ReviewPatch): Promise<Review>;
    /** Mark older finished reviews of the same repo, branch and scope as superseded by `review`. */
    markSuperseded(review: Review): Promise<string[]>;
    delete(id: string): Promise<void>;
    /** Delete reviews started before `before` (ms). Returns the ids deleted. */
    deleteOlderThan(before: number, repoId?: string): Promise<string[]>;
  };
  shards: {
    create(shard: Shard): Promise<Shard>;
    update(id: string, patch: ShardPatch): Promise<Shard>;
    listByReview(reviewId: string): Promise<Shard[]>;
  };
  findings: {
    create(finding: Finding): Promise<Finding>;
    get(id: string): Promise<Finding | undefined>;
    listByReview(reviewId: string): Promise<Finding[]>;
    update(id: string, patch: FindingPatch): Promise<Finding>;
    /** Move a finding (with its fixes and thread) to another review. */
    reassign(id: string, reviewId: string): Promise<void>;
    delete(id: string): Promise<void>;
  };
  fixes: {
    /** Adds a fix; if it is active, every other fix of the finding becomes inactive. */
    create(fix: Fix): Promise<Fix>;
    get(id: string): Promise<Fix | undefined>;
    listByFinding(findingId: string): Promise<Fix[]>;
    listByReview(reviewId: string): Promise<Fix[]>;
    active(findingId: string): Promise<Fix | undefined>;
    setActive(id: string): Promise<void>;
    update(id: string, patch: FixPatch): Promise<Fix>;
  };
  messages: {
    add(findingId: string, role: MessageRole, body: string): Promise<Message>;
    listByFinding(findingId: string): Promise<Message[]>;
    listByReview(reviewId: string): Promise<Message[]>;
  };
  suppressions: {
    add(repoId: string, fingerprint: string, reason: Suppression["reason"]): Promise<Suppression>;
    list(repoId: string): Promise<Suppression[]>;
    remove(repoId: string, fingerprint: string): Promise<void>;
  };
  cache: {
    get(key: string): Promise<CacheEntry | undefined>;
    put(entry: Omit<CacheEntry, "createdAt"> & { createdAt?: number }): Promise<void>;
    pruneOlderThan(before: number): Promise<number>;
  };
  events: {
    append(reviewId: string, type: string, payload: unknown): Promise<string>;
    list(
      reviewId: string,
      type?: string,
    ): Promise<{ id: string; type: string; payload: unknown; createdAt: number }[]>;
  };
  kv: {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
  };
}

function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`crit: ${what} not found`);
  return v;
}

export function createRepositories(db: Db): Repositories {
  const reviews: Repositories["reviews"] = {
    async create(review) {
      await db.insert(t.reviews).values(reviewToRow(review));
      return review;
    },
    async get(id) {
      const row = await db.select().from(t.reviews).where(eq(t.reviews.id, id)).get();
      return row ? reviewFromRow(row) : undefined;
    },
    async resolve(ref, repoId) {
      const needle = ref.toLowerCase();
      const match = or(
        eq(t.reviews.id, needle),
        like(t.reviews.id, `${needle}%`),
        needle.length <= 12 ? like(t.reviews.id, `%${needle}`) : undefined,
      );
      const rows = await db
        .select()
        .from(t.reviews)
        .where(repoId ? and(eq(t.reviews.repoId, repoId), match) : match)
        .orderBy(desc(t.reviews.startedAt))
        .all();
      const exact = rows.find((r) => r.id === needle);
      return (exact ? [exact] : rows).map(reviewFromRow);
    },
    async latest(repoId) {
      const row = await db
        .select()
        .from(t.reviews)
        .where(eq(t.reviews.repoId, repoId))
        .orderBy(desc(t.reviews.startedAt), desc(t.reviews.id))
        .limit(1)
        .get();
      return row ? reviewFromRow(row) : undefined;
    },
    async update(id, patch) {
      const current = must(await reviews.get(id), `review ${id}`);
      const next = { ...current, ...patch };
      await db.update(t.reviews).set(reviewToRow(next)).where(eq(t.reviews.id, id));
      return next;
    },
    async markSuperseded(review) {
      const rows = await db
        .select({ id: t.reviews.id })
        .from(t.reviews)
        .where(
          and(
            eq(t.reviews.repoId, review.repoId),
            eq(t.reviews.scopeLabel, review.scopeLabel),
            review.branch === null
              ? sql`${t.reviews.branch} IS NULL`
              : eq(t.reviews.branch, review.branch),
            ne(t.reviews.id, review.id),
            lt(t.reviews.startedAt, review.startedAt),
            inArray(t.reviews.status, ["completed", "failed", "cancelled"]),
          ),
        )
        .all();
      const ids = rows.map((r) => r.id);
      if (ids.length > 0) {
        await db
          .update(t.reviews)
          .set({ status: "superseded", supersededBy: review.id })
          .where(inArray(t.reviews.id, ids));
      }
      return ids;
    },
    async delete(id) {
      await db.delete(t.reviews).where(eq(t.reviews.id, id));
    },
    async deleteOlderThan(before, repoId) {
      const where = repoId
        ? and(lt(t.reviews.startedAt, before), eq(t.reviews.repoId, repoId))
        : lt(t.reviews.startedAt, before);
      const rows = await db.select({ id: t.reviews.id }).from(t.reviews).where(where).all();
      if (rows.length > 0) await db.delete(t.reviews).where(where);
      return rows.map((r) => r.id);
    },
  };

  const shards: Repositories["shards"] = {
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
  };

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

  const messages: Repositories["messages"] = {
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
      return rows.map((r) => messageFromRow(r.m));
    },
  };

  const suppressions: Repositories["suppressions"] = {
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
  };

  const cache: Repositories["cache"] = {
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
  };

  const events: Repositories["events"] = {
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
      return rows.map((r) => ({
        id: r.id,
        type: r.type,
        payload: JSON.parse(r.payload),
        createdAt: r.createdAt,
      }));
    },
  };

  const kv: Repositories["kv"] = {
    async get(key) {
      const row = await db.select().from(t.kv).where(eq(t.kv.key, key)).get();
      return row?.value;
    },
    async set(key, value) {
      const row = { key, value, createdAt: Date.now() };
      await db.insert(t.kv).values(row).onConflictDoUpdate({ target: t.kv.key, set: row });
    },
  };

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

  return { repos, reviews, shards, findings, fixes, messages, suppressions, cache, events, kv };
}

export type SqliteStore = Repositories & { connection: Connection; db: Db; close(): void };

/** Open the SQLite store at `path` (":memory:" for tests). Migrations run on open. */
export function openStore(path: string = ":memory:"): SqliteStore {
  const connection = openDatabase(path);
  return {
    ...createRepositories(connection.db),
    connection,
    db: connection.db,
    close: () => connection.close(),
  };
}
