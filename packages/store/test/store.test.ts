import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/db/migrations.gen.ts";
import { migrate, openStore, type SqliteStore } from "../src/index.ts";
import { renderMigrations } from "../scripts/embed-migrations.ts";
import { finding, fix, review, shard, tick } from "./factories.ts";

let store: SqliteStore;
let repoId: string;

beforeEach(async () => {
  store = openStore();
  repoId = (await store.repos.upsert({ root: "/work/shop", remoteUrl: null, name: "shop" })).id;
});
afterEach(() => store.close());

describe("migrations", () => {
  it("embedded migrations match drizzle/ (run `pnpm --filter @crit/store db:generate`)", () => {
    const onDisk = readFileSync(join(import.meta.dirname, "../src/db/migrations.gen.ts"), "utf8");
    expect(onDisk).toBe(renderMigrations());
  });

  it("are applied once and are idempotent", () => {
    expect(migrate(store.connection.raw)).toEqual([]);
    const rows = store.connection.raw.prepare("SELECT tag FROM crit_migrations").all();
    expect(rows).toHaveLength(MIGRATIONS.length);
  });

  it("persists to a file database across reopen, in WAL mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crit-store-"));
    try {
      const file = join(dir, "nested", "crit.db");
      const a = openStore(file);
      const repo = await a.repos.upsert({ root: "/r", remoteUrl: "git@x:y.git", name: "r" });
      const mode = a.connection.raw.prepare("PRAGMA journal_mode").get() as {
        journal_mode: string;
      };
      expect(mode.journal_mode).toBe("wal");
      a.close();
      const b = openStore(file);
      expect(await b.repos.get(repo.id)).toEqual(repo);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back a whole batch when one statement fails", async () => {
    const { repos } = await import("../src/db/schema.ts");
    const row = { id: "r1", rootPath: "/a", remoteUrl: null, name: "a", createdAt: 1 };
    await expect(
      store.db.batch([store.db.insert(repos).values(row), store.db.insert(repos).values(row)]),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    expect(await store.repos.get("r1")).toBeUndefined();
  });

  it("reports a failing migration with its tag and rolls back", () => {
    MIGRATIONS.push({ tag: "9999_broken", statements: ["CREATE TABLE x (a int)", "NOT SQL"] });
    try {
      expect(() => migrate(store.connection.raw)).toThrow(/migration 9999_broken failed/);
      const t = store.connection.raw
        .prepare("SELECT name FROM sqlite_master WHERE name = 'x'")
        .all();
      expect(t).toEqual([]);
    } finally {
      MIGRATIONS.pop();
    }
  });
});

describe("repos", () => {
  it("upserts by root path and updates remote/name", async () => {
    const again = await store.repos.upsert({
      root: "/work/shop",
      remoteUrl: "git@gh:a/shop.git",
      name: "shop2",
    });
    expect(again.id).toBe(repoId);
    expect(await store.repos.getByRoot("/work/shop")).toEqual(again);
    const same = await store.repos.upsert({
      root: "/work/shop",
      remoteUrl: "git@gh:a/shop.git",
      name: "shop2",
    });
    expect(same).toEqual(again);
    await store.repos.upsert({ root: "/work/api", remoteUrl: null, name: "api" });
    expect((await store.repos.list()).map((r) => r.name)).toEqual(["api", "shop2"]);
    expect(await store.repos.get("nope")).toBeUndefined();
  });
});

describe("reviews", () => {
  it("creates, reads and updates", async () => {
    const r = await store.reviews.create(review(repoId, { status: "running" }));
    expect(await store.reviews.get(r.id)).toEqual(r);
    const done = await store.reviews.update(r.id, {
      status: "completed",
      finishedAt: 5,
      summary: "ok",
    });
    expect(await store.reviews.get(r.id)).toEqual(done);
    await expect(store.reviews.update("missing", {})).rejects.toThrow(/review missing not found/);
  });

  it("resolves full ids, prefixes and short ids", async () => {
    const a = await store.reviews.create(review(repoId));
    const b = await store.reviews.create(review(repoId));
    expect(await store.reviews.resolve(a.id)).toEqual([a]);
    expect(await store.reviews.resolve(a.id.slice(-4))).toEqual([a]);
    expect(await store.reviews.resolve(a.id.slice(0, 8).toUpperCase(), repoId)).toEqual(
      expect.arrayContaining([a]),
    );
    expect(await store.reviews.resolve("zzzz")).toEqual([]);
    expect((await store.reviews.latest(repoId))?.id).toBe(b.id);
    expect(await store.reviews.latest("other")).toBeUndefined();
  });

  it("marks older finished reviews on the same branch and scope as superseded", async () => {
    const old1 = await store.reviews.create(review(repoId));
    const otherScope = await store.reviews.create(review(repoId, { scopeLabel: "src/db" }));
    const running = await store.reviews.create(review(repoId, { status: "running" }));
    const latest = await store.reviews.create(review(repoId));
    expect(await store.reviews.markSuperseded(latest)).toEqual([old1.id]);
    expect((await store.reviews.get(old1.id))?.status).toBe("superseded");
    expect((await store.reviews.get(old1.id))?.supersededBy).toBe(latest.id);
    expect((await store.reviews.get(otherScope.id))?.status).toBe("completed");
    expect((await store.reviews.get(running.id))?.status).toBe("running");
    expect(await store.reviews.markSuperseded(latest)).toEqual([]);
  });

  it("supersedes reviews with no branch (detached HEAD)", async () => {
    const a = await store.reviews.create(review(repoId, { branch: null, scopeLabel: "src" }));
    const b = await store.reviews.create(review(repoId, { branch: null, scopeLabel: "src" }));
    expect(await store.reviews.markSuperseded(b)).toEqual([a.id]);
  });

  it("deletes a review with all its children", async () => {
    const r = await store.reviews.create(review(repoId));
    await store.shards.create(shard(r.id));
    const f = await store.findings.create(finding(r.id));
    await store.fixes.create(fix(f.id));
    await store.messages.add(f.id, "user", "why?");
    await store.events.append(r.id, "applied", { n: 1 });
    await store.reviews.delete(r.id);
    const raw = store.connection.raw;
    for (const table of ["shards", "findings", "fixes", "messages", "events"]) {
      expect(raw.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });

  it("prunes reviews older than a cutoff, optionally per repo", async () => {
    const other = await store.repos.upsert({ root: "/o", remoteUrl: null, name: "o" });
    const old = await store.reviews.create(review(repoId, { startedAt: 1000 }));
    const oldOther = await store.reviews.create(review(other.id, { startedAt: 1000 }));
    const fresh = await store.reviews.create(review(repoId));
    expect(await store.reviews.deleteOlderThan(2000, repoId)).toEqual([old.id]);
    expect(await store.reviews.deleteOlderThan(2000, repoId)).toEqual([]);
    expect(await store.reviews.deleteOlderThan(2000)).toEqual([oldOther.id]);
    expect(await store.reviews.get(fresh.id)).toBeDefined();
  });
});

describe("shards and findings", () => {
  it("round-trips shards and updates them", async () => {
    const r = await store.reviews.create(review(repoId));
    const s = await store.shards.create(shard(r.id, { status: "running" }));
    const done = await store.shards.update(s.id, {
      status: "done",
      durationMs: 1500,
      inputTokens: 10,
    });
    expect(await store.shards.listByReview(r.id)).toEqual([done]);
    await expect(store.shards.update("missing", {})).rejects.toThrow(/shard missing/);
  });

  it("round-trips findings with optional fields and orders by file and line", async () => {
    const r = await store.reviews.create(review(repoId));
    const b = await store.findings.create(finding(r.id, { file: "b.ts" }));
    const a2 = await store.findings.create(
      finding(r.id, {
        file: "a.ts",
        range: { start: 50, end: 51 },
        shardId: "s1",
        failureScenario: "POST /refunds",
        verdict: "confirmed",
        verdictReason: "real",
        dismissReason: "later",
        groupId: "g1",
        mergedFrom: ["x"],
      }),
    );
    const a1 = await store.findings.create(
      finding(r.id, { file: "a.ts", range: { start: 3, end: 3 } }),
    );
    expect(await store.findings.listByReview(r.id)).toEqual([a1, a2, b]);
    const updated = await store.findings.update(a1.id, { selected: false, status: "dismissed" });
    expect(await store.findings.get(a1.id)).toEqual(updated);
    const other = await store.reviews.create(review(repoId));
    await store.findings.reassign(b.id, other.id);
    expect((await store.findings.get(b.id))!.reviewId).toBe(other.id);
    await store.findings.delete(b.id);
    expect(await store.findings.get(b.id)).toBeUndefined();
    await expect(store.findings.update("missing", {})).rejects.toThrow(/finding missing/);
  });
});

describe("fixes and messages", () => {
  it("keeps exactly one active fix per finding", async () => {
    const r = await store.reviews.create(review(repoId));
    const f = await store.findings.create(finding(r.id));
    const ai = await store.fixes.create(fix(f.id));
    const user = await store.fixes.create(
      fix(f.id, {
        author: "user",
        evaluation: "concerns",
        evaluationReason: "null check",
        verify: {
          passed: true,
          commands: [{ command: "pnpm test", exitCode: 0, durationMs: 10, output: "" }],
        },
      }),
    );
    expect((await store.fixes.active(f.id))?.id).toBe(user.id);
    expect((await store.fixes.get(ai.id))?.active).toBe(false);
    await store.fixes.setActive(ai.id);
    expect((await store.fixes.active(f.id))?.id).toBe(ai.id);
    const inactive = await store.fixes.create(fix(f.id, { active: false }));
    expect((await store.fixes.active(f.id))?.id).toBe(ai.id);
    expect((await store.fixes.listByFinding(f.id)).map((x) => x.id)).toEqual([
      ai.id,
      user.id,
      inactive.id,
    ]);
    expect(await store.fixes.listByReview(r.id)).toHaveLength(3);
    const upd = await store.fixes.update(user.id, { overridden: true });
    expect((await store.fixes.get(user.id))?.overridden).toBe(true);
    expect(upd.verify?.passed).toBe(true);
    await expect(store.fixes.setActive("nope")).rejects.toThrow(/fix nope/);
    await expect(store.fixes.update("nope", {})).rejects.toThrow(/fix nope/);
    expect(await store.fixes.active("nope")).toBeUndefined();
  });

  it("stores a thread in order", async () => {
    const r = await store.reviews.create(review(repoId));
    const f = await store.findings.create(finding(r.id));
    await store.messages.add(f.id, "user", "Can session.user be null?");
    await store.messages.add(f.id, "ai", "Yes, on logout.");
    expect((await store.messages.listByFinding(f.id)).map((m) => m.role)).toEqual(["user", "ai"]);
    expect(await store.messages.listByReview(r.id)).toHaveLength(2);
  });
});

describe("suppressions, cache, events, kv", () => {
  it("upserts suppressions per repo and fingerprint", async () => {
    await store.suppressions.add(repoId, "fp1", "false-positive");
    await store.suppressions.add(repoId, "fp1", "wont-fix");
    await store.suppressions.add(repoId, "fp2", "wont-fix");
    const list = await store.suppressions.list(repoId);
    expect(list.map((s) => [s.fingerprint, s.reason])).toEqual([
      ["fp1", "wont-fix"],
      ["fp2", "wont-fix"],
    ]);
    await store.suppressions.remove(repoId, "fp1");
    expect(await store.suppressions.list(repoId)).toHaveLength(1);
  });

  it("caches results and prunes old entries", async () => {
    await store.cache.put({
      key: "k1",
      reviewId: null,
      value: "[]",
      transcriptPath: null,
      createdAt: 10,
    });
    await store.cache.put({
      key: "k1",
      reviewId: null,
      value: "[1]",
      transcriptPath: "/t",
      createdAt: 10,
    });
    await store.cache.put({ key: "k2", reviewId: null, value: "[]", transcriptPath: null });
    expect((await store.cache.get("k1"))?.value).toBe("[1]");
    expect(await store.cache.pruneOlderThan(100)).toBe(1);
    expect(await store.cache.pruneOlderThan(100)).toBe(0);
    expect(await store.cache.get("k1")).toBeUndefined();
  });

  it("appends and filters events", async () => {
    const r = await store.reviews.create(review(repoId));
    await store.events.append(r.id, "apply", { backup: "/b.patch" });
    await store.events.append(r.id, "undo", undefined);
    expect((await store.events.list(r.id)).map((e) => e.type)).toEqual(["apply", "undo"]);
    const [apply] = await store.events.list(r.id, "apply");
    expect(apply?.payload).toEqual({ backup: "/b.patch" });
  });

  it("reads and overwrites kv", async () => {
    expect(await store.kv.get("a")).toBeUndefined();
    await store.kv.set("a", "1");
    await store.kv.set("a", "2");
    expect(await store.kv.get("a")).toBe("2");
  });
});

describe("factories clock", () => {
  it("moves forward", () => {
    expect(tick(0)).toBeLessThan(tick());
  });
});
