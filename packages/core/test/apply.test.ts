import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Finding, type Fix, newId } from "@crit/schema";
import { openStore, type SqliteStore } from "@crit/store";
import { createFixtureRepo, type FixtureRepo } from "@crit/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyFixes,
  findOverlaps,
  plannedFixes,
  runShell,
  runVerify,
  undoApply,
} from "../src/index.ts";

const FILE = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const patchFor = (line: number, to: string, path = "src/a.ts") =>
  `--- a/${path}\n+++ b/${path}\n@@ -${line} +${line} @@\n-line ${line}\n+${to}\n`;

let repo: FixtureRepo;
let store: SqliteStore;
let backups: string;
let reviewId: string;

beforeEach(async () => {
  repo = createFixtureRepo({ "src/a.ts": FILE, "src/b.ts": "b1\nb2\n" });
  store = openStore();
  backups = mkdtempSync(join(tmpdir(), "crit-backups-"));
  const r = await store.repos.upsert({ root: repo.root, remoteUrl: null, name: "x" });
  reviewId = newId();
  await store.reviews.create({
    id: reviewId,
    repoId: r.id,
    scope: { kind: "project" },
    scopeLabel: "whole project",
    branch: "main",
    baseSha: null,
    headSha: null,
    provider: "fake",
    model: null,
    lenses: ["correctness"],
    status: "completed",
    supersededBy: null,
    summary: null,
    rulesHeader: null,
    startedAt: Date.now(),
    finishedAt: null,
  });
});
afterEach(() => {
  store.close();
  repo.cleanup();
  rmSync(backups, { recursive: true, force: true });
});

async function addFinding(
  line: number,
  patch: string | undefined,
  over: Partial<Finding> = {},
): Promise<Finding> {
  const f: Finding = {
    id: newId(),
    reviewId,
    fingerprint: `fp${line}${Math.random()}`,
    file: "src/a.ts",
    range: { start: line, end: line },
    anchor: `line ${line}`,
    severity: "major",
    category: "correctness",
    title: `Fix line ${line}`,
    explanation: "x",
    confidence: 0.9,
    ruleIds: [],
    status: "open",
    selected: true,
    mergedFrom: [],
    createdAt: Date.now(),
    ...over,
  };
  await store.findings.create(f);
  if (patch) {
    const fix: Fix = {
      id: newId(),
      findingId: f.id,
      author: "ai",
      patch,
      summary: `change ${line}`,
      overridden: false,
      active: true,
      createdAt: Date.now(),
    };
    await store.fixes.create(fix);
  }
  return f;
}

const status = () => repo.git("status", "--porcelain");
const read = (p: string) => readFileSync(join(repo.root, p), "utf8");

describe("plannedFixes and overlaps", () => {
  it("plans checked, open findings with an active fix", async () => {
    await addFinding(2, patchFor(2, "two"));
    await addFinding(3, patchFor(3, "three"), { selected: false });
    await addFinding(4, patchFor(4, "four"), { verdict: "rejected" });
    await addFinding(5, patchFor(5, "five"), { status: "dismissed" });
    await addFinding(6, undefined);
    expect((await plannedFixes(store, reviewId)).map((p) => p.finding.range.start)).toEqual([2]);
  });

  it("finds fixes touching the same or adjacent lines", async () => {
    const a = await addFinding(5, patchFor(5, "x"));
    const b = await addFinding(6, patchFor(6, "y"));
    await addFinding(15, patchFor(15, "z"));
    const planned = await plannedFixes(store, reviewId);
    expect(findOverlaps(planned)).toEqual([{ file: "src/a.ts", a: a.id, b: b.id }]);
  });
});

describe("apply to the working tree, then undo", () => {
  it("applies fixes, backs up, and undo restores the tree exactly (keeping prior uncommitted edits)", async () => {
    // The user already has an uncommitted change in the same file.
    repo.write({ "src/a.ts": FILE.replace("line 19", "line 19 (wip)") });
    const before = { status: status(), a: read("src/a.ts"), b: read("src/b.ts") };
    await addFinding(2, patchFor(2, "two"));
    await addFinding(10, patchFor(10, "ten"));
    await addFinding(1, "--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-b1\n+B1\n", {
      file: "src/b.ts",
    });
    await addFinding(3, "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+export {};\n", {
      file: "src/new.ts",
    });

    const r = await applyFixes({ store, reviewId, root: repo.root, backupRoot: backups });
    expect(r.applied).toHaveLength(4);
    expect(r.skipped).toEqual([]);
    expect(read("src/a.ts")).toContain("two\n");
    expect(read("src/a.ts")).toContain("ten\n");
    expect(read("src/a.ts")).toContain("line 19 (wip)");
    expect(existsSync(join(repo.root, "src/new.ts"))).toBe(true);
    expect(readFileSync(join(r.backupDir!, "applied.patch"), "utf8")).toContain("+ten");
    expect((await store.findings.listByReview(reviewId)).every((f) => f.status === "applied")).toBe(
      true,
    );

    const u = await undoApply({ store, reviewIds: [reviewId], root: repo.root });
    expect(u.restored.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(u.removed).toEqual(["src/new.ts"]);
    expect({ status: status(), a: read("src/a.ts"), b: read("src/b.ts") }).toEqual(before);
    expect((await store.findings.listByReview(reviewId)).every((f) => f.status === "open")).toBe(
      true,
    );
    await expect(undoApply({ store, reviewIds: [reviewId], root: repo.root })).rejects.toThrow(
      "nothing to undo",
    );
  });

  it("refuses to undo over later edits unless forced", async () => {
    await addFinding(2, patchFor(2, "two"));
    await applyFixes({ store, reviewId, root: repo.root, backupRoot: backups });
    repo.write({ "src/a.ts": `${read("src/a.ts")}more\n` });
    await expect(undoApply({ store, reviewIds: [reviewId], root: repo.root })).rejects.toThrow(
      /src\/a.ts changed after the fixes were applied/,
    );
    await undoApply({ store, reviewIds: [reviewId], root: repo.root, force: true });
    expect(read("src/a.ts")).toBe(FILE);
  });

  it("skips a conflicting fix, or applies the agent's rebased version", async () => {
    await addFinding(5, patchFor(5, "five-a"));
    const b = await addFinding(5, patchFor(5, "five-b"), { title: "Other fix" });
    const skipped = await applyFixes({ store, reviewId, root: repo.root, backupRoot: backups });
    expect(skipped.overlaps).toHaveLength(1);
    expect(skipped.applied).toHaveLength(1);
    expect(skipped.skipped[0]!.reason).toMatch(/^does not apply/);
    await undoApply({ store, reviewIds: [reviewId], root: repo.root });

    const seen: string[] = [];
    const rebased = await applyFixes({
      store,
      reviewId,
      root: repo.root,
      backupRoot: backups,
      rebase: async (item, current, error) => {
        seen.push(error);
        const winner = item.finding.id === b.id ? "five-a" : "five-b";
        expect(current["src/a.ts"]).toContain(winner);
        return `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -5 +5 @@\n-${winner}\n+five-a-and-b\n`;
      },
    });
    expect(rebased.applied).toHaveLength(2);
    expect(rebased.rebased).toHaveLength(1);
    expect(seen[0]).toMatch(/patch failed|does not apply/);
    expect(read("src/a.ts")).toContain("five-a-and-b");
  });

  it("runs verify commands and records the result on each fix", async () => {
    const f = await addFinding(2, patchFor(2, "two"));
    const r = await applyFixes({
      store,
      reviewId,
      root: repo.root,
      backupRoot: backups,
      verifyCommands: ["git diff --quiet || echo changed", "exit 0"],
    });
    expect(r.verify).toMatchObject({
      passed: true,
      commands: [{ exitCode: 0, output: expect.stringContaining("changed") }, { exitCode: 0 }],
    });
    expect((await store.fixes.active(f.id))!.verify?.passed).toBe(true);
  });

  it("does nothing when no fixes are checked", async () => {
    await addFinding(2, patchFor(2, "two"), { selected: false });
    expect(await applyFixes({ store, reviewId, root: repo.root, backupRoot: backups })).toEqual({
      applied: [],
      skipped: [],
      overlaps: [],
      rebased: [],
    });
  });
});

describe("apply to a new branch", () => {
  it("commits one fix per finding in a worktree, leaving the checkout untouched; undo deletes the branch", async () => {
    await addFinding(2, patchFor(2, "two"));
    await addFinding(10, patchFor(10, "ten"));
    const head = repo.git("rev-parse", "HEAD");
    const r = await applyFixes({
      store,
      reviewId,
      root: repo.root,
      backupRoot: backups,
      target: { kind: "branch" },
      verifyCommands: ["exit 3"],
    });
    expect(r.branch).toMatch(/^crit\/fixes-[0-9a-f]{4}$/);
    expect(status()).toBe("");
    expect(repo.git("rev-parse", "HEAD")).toBe(head);
    expect(repo.git("log", "--format=%s", `${head}..${r.branch}`).split("\n")).toEqual([
      "crit: Fix line 2",
      "crit: Fix line 10",
    ]);
    expect(r.verify?.passed).toBe(false);
    expect(repo.git("worktree", "list").split("\n")).toHaveLength(1);
    for (const f of await store.findings.listByReview(reviewId))
      await store.findings.update(f.id, { status: "open" });
    await expect(
      applyFixes({
        store,
        reviewId,
        root: repo.root,
        backupRoot: backups,
        target: { kind: "branch" },
      }),
    ).rejects.toThrow(/already exists/);

    const u = await undoApply({ store, reviewIds: [reviewId], root: repo.root });
    expect(u.branchDeleted).toBe(r.branch);
    expect(repo.git("branch", "--list", r.branch!)).toBe("");
  });

  it("squashes into one commit, and removes an empty branch", async () => {
    await addFinding(2, patchFor(2, "two"));
    await addFinding(10, patchFor(10, "ten"));
    const head = repo.git("rev-parse", "HEAD");
    const r = await applyFixes({
      store,
      reviewId,
      root: repo.root,
      backupRoot: backups,
      target: { kind: "branch", squash: true, name: "fixes" },
    });
    expect(repo.git("rev-list", "--count", `${head}..fixes`)).toBe("1");
    expect(r.applied).toHaveLength(2);

    await undoApply({ store, reviewIds: [reviewId], root: repo.root });
    repo.write({ "src/a.ts": "rewritten\n" });
    repo.commit("rewrite");
    const none = await applyFixes({
      store,
      reviewId,
      root: repo.root,
      backupRoot: backups,
      target: { kind: "branch", name: "fixes2" },
    });
    expect(none.applied).toEqual([]);
    expect(repo.git("branch", "--list", "fixes2")).toBe("");
  });

  it("will not delete a checked-out fixes branch", async () => {
    await addFinding(2, patchFor(2, "two"));
    const r = await applyFixes({
      store,
      reviewId,
      root: repo.root,
      backupRoot: backups,
      target: { kind: "branch" },
    });
    repo.git("checkout", "-q", r.branch!);
    await expect(undoApply({ store, reviewIds: [reviewId], root: repo.root })).rejects.toThrow(
      /is checked out/,
    );
  });
});

describe("shell commands", () => {
  it("captures output, failures, timeouts and stops at the first failure", async () => {
    expect(await runShell("echo hi", repo.root)).toMatchObject({ exitCode: 0, output: "hi\n" });
    const slow = await runShell("sleep 5", repo.root, 100);
    expect(slow.output).toContain("timed out");
    const v = await runVerify(["exit 1", "echo never"], repo.root);
    expect(v).toMatchObject({ passed: false, commands: [{ command: "exit 1", exitCode: 1 }] });
  });
});
