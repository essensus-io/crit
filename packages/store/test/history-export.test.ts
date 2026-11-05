import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compareFindings,
  exportReview,
  importReview,
  listHistory,
  openStore,
  type SqliteStore,
} from "../src/index.ts";
import { finding, fix, review, shard } from "./factories.ts";

let store: SqliteStore;
let repoId: string;

beforeEach(async () => {
  store = openStore();
  repoId = (await store.repos.upsert({ root: "/work/shop", remoteUrl: null, name: "shop" })).id;
});
afterEach(() => store.close());

describe("listHistory", () => {
  it("lists newest first with severity counts and outcomes", async () => {
    const older = await store.reviews.create(
      review(repoId, { scopeLabel: "src/db", provider: "codex" }),
    );
    await store.findings.create(finding(older.id, { severity: "major", status: "applied" }));
    const newer = await store.reviews.create(review(repoId));
    await store.findings.create(finding(newer.id, { severity: "critical" }));
    await store.findings.create(finding(newer.id, { severity: "major", status: "applied" }));
    await store.findings.create(finding(newer.id, { severity: "nit", status: "dismissed" }));
    await store.findings.create(finding(newer.id, { severity: "minor", status: "fixed" }));
    await store.findings.create(finding(newer.id, { severity: "minor", status: "closed" }));
    await store.findings.create(finding(newer.id, { severity: "minor", verdict: "rejected" }));

    const rows = await listHistory(store.db, { repoId });
    expect(rows.map((r) => r.review.id)).toEqual([newer.id, older.id]);
    expect(rows[0]!.severity).toEqual({ critical: 1, major: 1, minor: 2, nit: 1 });
    expect(rows[0]!.outcome).toEqual({ applied: 2, dismissed: 1, open: 1, filtered: 1 });
    expect(rows[0]!.repoName).toBe("shop");
    expect(rows[1]!.outcome.applied).toBe(1);
  });

  it("totals reviewer shard tokens and skeptic usage events per review", async () => {
    const r = await store.reviews.create(review(repoId));
    await store.shards.create(
      shard(r.id, { inputTokens: 1000, cachedTokens: 9000, outputTokens: 100 }),
    );
    await store.shards.create(
      shard(r.id, { inputTokens: 500, cachedTokens: null, outputTokens: 50 }),
    );
    await store.events.append(r.id, "usage", {
      task: "skeptic",
      inputTokens: 200,
      cachedInputTokens: 1000,
      outputTokens: 20,
    });
    await store.events.append(r.id, "rules", { rules: [] });
    const empty = await store.reviews.create(review(repoId));
    const rows = await listHistory(store.db, { repoId });
    const byId = Object.fromEntries(rows.map((x) => [x.review.id, x.tokens]));
    expect(byId[r.id]).toEqual({
      inputTokens: 1700,
      cachedInputTokens: 10_000,
      outputTokens: 170,
      effective: 1700 + 170 + 1000,
    });
    expect(byId[empty.id]).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      effective: 0,
    });
  });

  it("filters by branch, scope, provider, date and limit", async () => {
    const a = await store.reviews.create(
      review(repoId, { branch: "main", scopeLabel: "src/db", provider: "codex" }),
    );
    const b = await store.reviews.create(review(repoId));
    const other = await store.repos.upsert({ root: "/x", remoteUrl: null, name: "x" });
    const c = await store.reviews.create(review(other.id));
    const ids = async (f: Parameters<typeof listHistory>[1]) =>
      (await listHistory(store.db, f)).map((r) => r.review.id);
    expect(await ids({ repoId, branch: "main" })).toEqual([a.id]);
    expect(await ids({ repoId, scope: "SRC/DB" })).toEqual([a.id]);
    expect(await ids({ provider: "codex" })).toEqual([a.id]);
    expect(await ids({ since: b.startedAt })).toEqual([c.id, b.id]);
    expect(await ids({ until: a.startedAt })).toEqual([a.id]);
    expect(await ids({ limit: 1 })).toEqual([c.id]);
    expect(await ids({})).toHaveLength(3);
    expect(await ids({ repoId: "none" })).toEqual([]);
  });
});

describe("compareFindings", () => {
  it("splits findings into fixed, new and still open by fingerprint", () => {
    const fp = (fingerprint: string, over = {}) => finding("r", { fingerprint, ...over });
    const a = [
      fp("gone"),
      fp("same"),
      fp("applied-later"),
      fp("applied-before", { status: "applied" }),
      fp("rej", { verdict: "rejected" }),
    ];
    const b = [
      fp("same"),
      fp("applied-later", { status: "applied" }),
      fp("applied-before"),
      fp("brand-new"),
      fp("rej2", { verdict: "rejected" }),
    ];
    const c = compareFindings(a, b);
    expect(c.fixed.map((f) => f.fingerprint)).toEqual(["gone", "applied-later", "applied-before"]);
    expect(c.new.map((f) => f.fingerprint)).toEqual(["brand-new"]);
    expect(c.stillOpen.map((f) => f.fingerprint)).toEqual(["same", "applied-before"]);
  });
});

describe("export and import", () => {
  async function seed() {
    const r = await store.reviews.create(review(repoId, { summary: "2 issues", finishedAt: 99 }));
    await store.shards.create(shard(r.id));
    const f1 = await store.findings.create(finding(r.id, { verdict: "confirmed" }));
    const f2 = await store.findings.create(finding(r.id, { file: "z.ts", failureScenario: "x" }));
    await store.fixes.create(fix(f1.id));
    await store.fixes.create(fix(f1.id, { author: "user", evaluation: "accepted" }));
    await store.messages.add(f2.id, "user", "really?");
    return r;
  }

  it("exports a versioned document and imports it back unchanged", async () => {
    const r = await seed();
    const doc = await exportReview(store, r.id);
    expect(doc.format).toBe("crit.review");
    expect(doc.version).toBe(1);
    expect(doc.findings).toHaveLength(2);
    expect(doc.fixes).toHaveLength(2);
    expect(doc.messages).toHaveLength(1);

    const json = JSON.parse(JSON.stringify(doc));
    const fresh = openStore();
    try {
      await importReview(fresh, json);
      const again = await exportReview(fresh, r.id);
      expect({ ...again, exportedAt: 0 }).toEqual({ ...doc, exportedAt: 0 });
    } finally {
      fresh.close();
    }
  });

  it("re-importing replaces the review and reuses a repo with the same root", async () => {
    const r = await seed();
    const doc = await exportReview(store, r.id);
    const other = openStore();
    try {
      const local = await other.repos.upsert({ root: "/work/shop", remoteUrl: null, name: "shop" });
      const imported = await importReview(other, doc);
      expect(imported.review.repoId).toBe(local.id);
      await importReview(other, doc);
      expect(await other.findings.listByReview(r.id)).toHaveLength(2);
    } finally {
      other.close();
    }
  });

  it("rejects unknown documents and missing reviews", async () => {
    await expect(importReview(store, { format: "nope" })).rejects.toThrow(/crit\.review/);
    await expect(exportReview(store, "missing")).rejects.toThrow(/review missing not found/);
  });
});
