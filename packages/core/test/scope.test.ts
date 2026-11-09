import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureRepo, type FixtureRepo, gitTestEnv } from "@crit/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectBase, GitError, git, repoRoot } from "../src/git.ts";
import { pathMatcher, reportableFiles, resolveScope, ScopeError } from "../src/scope.ts";

let repo: FixtureRepo;

const BASE_FILES = {
  "src/api/payments.ts": "export function refund(amount: number) {\n  return amount;\n}\n",
  "src/api/webhooks.ts": "export const verify = (a: string, b: string) => a === b;\n",
  "src/db/orders.ts": "export const list = () => [];\n",
  "src/db/schema.sql": "create table orders (id int);\n",
  "README.md": "# shop\n",
  "pnpm-lock.yaml": "lockfileVersion: 9\n",
};

beforeEach(() => {
  repo = createFixtureRepo(BASE_FILES);
});
afterEach(() => repo.cleanup());

const paths = (s: { files: { path: string }[] }) => s.files.map((f) => f.path).sort();

describe("branch scope", () => {
  beforeEach(() => {
    repo.git("checkout", "-q", "-b", "feature/payments");
    repo.commit("validate refunds", {
      "src/api/payments.ts":
        "export function refund(amount: number) {\n  if (amount <= 0) throw new Error();\n  return amount;\n}\n",
    });
    repo.git("mv", "src/db/orders.ts", "src/db/order-repo.ts");
    repo.commit("rename");
    repo.remove("src/api/webhooks.ts");
    repo.write({
      "src/db/schema.sql": "create table orders (id int, total int);\n",
      "src/new/untracked.ts": "export const x = 1;",
      ".env": "SECRET=1\n",
      "bin.dat": "\0\0\0binary",
    });
  });

  it("diffs merge-base..HEAD plus uncommitted and untracked changes", async () => {
    const s = await resolveScope({ cwd: repo.root, spec: { kind: "branch", base: "main" } });
    expect(s.label).toBe("feature/payments → main");
    expect(s.branch).toBe("feature/payments");
    expect(s.baseSha).toBe(repo.git("rev-parse", "main"));
    expect(s.headSha).toBe(repo.git("rev-parse", "HEAD"));
    const byPath = Object.fromEntries(s.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual([
      "src/api/payments.ts",
      "src/api/webhooks.ts",
      "src/db/schema.sql",
      "src/new/untracked.ts",
    ]);
    expect(byPath["src/api/payments.ts"]!.hunks).toEqual([{ start: 1, lines: 4 }]);
    expect(byPath["src/api/webhooks.ts"]!.status).toBe("deleted");
    expect(s.skipped).toContainEqual({
      path: "src/db/order-repo.ts",
      reason: "renamed without changes",
    });
    expect(byPath["src/new/untracked.ts"]).toMatchObject({
      status: "added",
      hunks: [{ start: 1, lines: 1 }],
    });
    expect(s.ignored.sort()).toEqual([".env", "bin.dat", "src/db/order-repo.ts"]);
    expect(s.diff).toContain("+  if (amount <= 0) throw new Error();");
    expect(s.diff).toContain("+export const x = 1;\n\\ No newline at end of file");
    expect([...reportableFiles(s)]).not.toContain("src/api/webhooks.ts");
  });

  it("keeps a renamed file that was also edited, and skips a renamed font", async () => {
    repo.write({ "assets/Font.otf": "OTF-not-really-binary" });
    repo.commit("add font", {});
    repo.git("mv", "assets/Font.otf", "assets/Font-Bold.otf");
    repo.git("mv", "src/db/schema.sql", "src/db/tables.sql");
    repo.write({ "src/db/tables.sql": "create table orders (id int, edited int);\n" });
    repo.commit("renames");
    const s = await resolveScope({ cwd: repo.root, spec: { kind: "branch", base: "main" } });
    expect(s.files.map((f) => f.path)).toContain("src/db/tables.sql");
    expect(s.skipped).toContainEqual({ path: "assets/Font-Bold.otf", reason: "binary file" });
    expect(s.files.map((f) => f.path)).not.toContain("assets/Font-Bold.otf");
  });

  it("picks the nearest integration branch: a branch off develop is reviewed against develop, not a stale main", async () => {
    repo.git("checkout", "-q", "-b", "develop");
    repo.commit("develop 1", { "src/dev1.ts": "export const d1 = 1;\n" });
    repo.commit("develop 2", { "src/dev2.ts": "export const d2 = 1;\n" });
    repo.git("checkout", "-q", "-b", "feature/x");
    repo.commit("feature", { "src/x.ts": "export const x = 1;\n" });
    expect(await detectBase(repo.root)).toBe("develop");
    const s = await resolveScope({ cwd: repo.root, spec: { kind: "branch" } });
    expect(s.label).toBe("feature/x → develop");
    expect(paths(s)).toEqual(["src/x.ts"]);
    repo.git("checkout", "-q", "develop");
    expect(await detectBase(repo.root)).toBe("main");
    repo.git("checkout", "-q", "-b", "other", "main");
    repo.commit("other", { "src/o.ts": "export const o = 1;\n" });
    expect(await detectBase(repo.root)).toBe("main");
  });

  it("detects the base from local main when there is no remote", async () => {
    const s = await resolveScope({ cwd: repo.root, spec: { kind: "branch" } });
    expect(s.baseRef).toBe("main");
  });

  it("applies extra ignores", async () => {
    const s = await resolveScope({
      cwd: repo.root,
      spec: { kind: "branch", base: "main" },
      ignore: ["**/*.sql"],
    });
    expect(paths(s)).not.toContain("src/db/schema.sql");
    expect(s.ignored).toContain("src/db/schema.sql");
  });

  it("fails clearly without a base", async () => {
    repo.git("branch", "-m", "main", "stable");
    await expect(resolveScope({ cwd: repo.root, spec: { kind: "branch" } })).rejects.toThrow(
      /Pass --base/,
    );
    await expect(
      resolveScope({ cwd: repo.root, spec: { kind: "branch", base: "nope" } }),
    ).rejects.toThrow(ScopeError);
  });
});

describe("base detection", () => {
  it("prefers an upstream that tracks another branch, then the nearest remote branch", async () => {
    const remote = createFixtureRepo({ "a.txt": "a\n" });
    const clone = mkdtempSync(join(tmpdir(), "crit-clone-"));
    try {
      execFileSync("git", ["clone", "-q", remote.root, clone], { env: gitTestEnv() });
      await git(clone, ["checkout", "-q", "-b", "feature", "--track", "origin/main"]);
      expect(await detectBase(clone)).toBe("origin/main");
      await git(clone, ["branch", "-q", "--unset-upstream"]);
      await git(clone, ["remote", "set-head", "origin", "main"]);
      expect(await detectBase(clone)).toBe("origin/main");
      await git(clone, ["remote", "set-head", "origin", "-d"]);
      expect(await detectBase(clone)).toBe("origin/main");
    } finally {
      remote.cleanup();
      rmSync(clone, { recursive: true, force: true });
    }
  });
});

describe("staged and commit scopes", () => {
  it("reviews only staged changes", async () => {
    repo.write({
      "src/db/orders.ts": "export const list = () => [1];\n",
      "README.md": "# changed\n",
    });
    repo.git("add", "src/db/orders.ts");
    const s = await resolveScope({ cwd: repo.root, spec: { kind: "staged" } });
    expect(s.label).toBe("staged changes");
    expect(paths(s)).toEqual(["src/db/orders.ts"]);
  });

  it("reviews staged files in a repo with no commits", async () => {
    const empty = createFixtureRepo();
    try {
      empty.write({ "a.ts": "a\n" });
      empty.git("add", "a.ts");
      const s = await resolveScope({ cwd: empty.root, spec: { kind: "staged" } });
      expect(paths(s)).toEqual(["a.ts"]);
      await expect(resolveScope({ cwd: empty.root, spec: { kind: "branch" } })).rejects.toThrow(
        /no commits/,
      );
    } finally {
      empty.cleanup();
    }
  });

  it("reviews one commit, including the root commit", async () => {
    const sha = repo.commit("touch orders", {
      "src/db/orders.ts": "export const list = () => [2];\n",
    });
    const s = await resolveScope({
      cwd: repo.root,
      spec: { kind: "commit", sha: sha.slice(0, 8) },
    });
    expect(s.label).toBe(`commit ${sha.slice(0, 7)}`);
    expect(s.headSha).toBe(sha);
    expect(paths(s)).toEqual(["src/db/orders.ts"]);

    const root = repo.git("rev-list", "--max-parents=0", "HEAD");
    const r = await resolveScope({ cwd: repo.root, spec: { kind: "commit", sha: root } });
    expect(paths(r)).toEqual([
      "src/api/payments.ts",
      "src/api/webhooks.ts",
      "src/db/orders.ts",
      "src/db/schema.sql",
    ]);
    expect(r.ignored.sort()).toEqual(["README.md", "pnpm-lock.yaml"]);
    expect(r.skipped).toContainEqual({
      path: "README.md",
      reason: "docs, assets or generated (default ignore)",
    });
    expect(r.skipped).toContainEqual({ path: "pnpm-lock.yaml", reason: "secret, key or lockfile" });
    await expect(
      resolveScope({ cwd: repo.root, spec: { kind: "commit", sha: "deadbeef" } }),
    ).rejects.toThrow(/unknown commit/);
  });
});

describe("path and project scopes", () => {
  it("selects folders, files and globs, minus ignores", async () => {
    repo.commit("more", { "src/api/key.pem": "-----BEGIN-----\n", "docs/q.sql": "select 1;\n" });
    const s = await resolveScope({
      cwd: repo.root,
      spec: { kind: "paths", paths: ["src/api", "README.md", "**/*.sql"], diff: false },
    });
    expect(s.label).toBe("src/api README.md **/*.sql");
    expect(paths(s)).toEqual([
      "README.md",
      "docs/q.sql",
      "src/api/payments.ts",
      "src/api/webhooks.ts",
      "src/db/schema.sql",
    ]);
    expect(s.ignored).toEqual(["src/api/key.pem"]);
    expect(s.files[0]!.status).toBe("unchanged");
    expect(s.files.every((f) => f.size > 0)).toBe(true);
  });

  it("resolves paths relative to a subfolder", async () => {
    const s = await resolveScope({
      cwd: join(repo.root, "src"),
      spec: { kind: "paths", paths: ["db", "*.ts"], diff: false },
    });
    expect(paths(s)).toEqual(["src/db/orders.ts", "src/db/schema.sql"]);
    const all = await resolveScope({
      cwd: join(repo.root, "src"),
      spec: { kind: "paths", paths: ["."], diff: false },
    });
    expect(paths(all)).toHaveLength(4);
    const g = await resolveScope({
      cwd: join(repo.root, "src"),
      spec: { kind: "paths", paths: ["api/*.ts"], diff: false },
    });
    expect(paths(g)).toEqual(["src/api/payments.ts", "src/api/webhooks.ts"]);
  });

  it("limits a path scope to changed files with diff", async () => {
    repo.git("checkout", "-q", "-b", "f");
    repo.commit("c", { "src/db/orders.ts": "x\n", "README.md": "y\n" });
    const s = await resolveScope({
      cwd: repo.root,
      spec: { kind: "paths", paths: ["src"], diff: true, base: "main" },
    });
    expect(paths(s)).toEqual(["src/db/orders.ts"]);
    expect(s.label).toBe("src (changed vs main)");
  });

  it("rejects paths outside the repo and empty matches", async () => {
    await expect(
      resolveScope({ cwd: repo.root, spec: { kind: "paths", paths: ["../x"], diff: false } }),
    ).rejects.toThrow(/outside the repository/);
    await expect(
      resolveScope({ cwd: repo.root, spec: { kind: "paths", paths: ["nope"], diff: false } }),
    ).rejects.toThrow(/no tracked files match nope/);
  });

  it("reviews every tracked file for the project scope", async () => {
    mkdirSync(join(repo.root, "img"));
    writeFileSync(join(repo.root, "img", "a.png"), Buffer.from([0x89, 0, 1, 2]));
    repo.commit("img");
    repo.write({ "untracked.ts": "x" });
    const s = await resolveScope({ cwd: repo.root, spec: { kind: "project" } });
    expect(s.label).toBe("whole project");
    expect(paths(s)).toEqual([
      "src/api/payments.ts",
      "src/api/webhooks.ts",
      "src/db/orders.ts",
      "src/db/schema.sql",
    ]);
    expect(s.ignored.sort()).toEqual(["README.md", "img/a.png", "pnpm-lock.yaml"]);
  });

  it("skips files above maxFileTokens unless they are named; named docs bypass the noise list", async () => {
    repo.commit("big", {
      "src/big.ts": "x".repeat(4000),
      "docs/guide.md": "# guide\n",
      "src/api/a.svg": "<svg/>",
    });
    const all = await resolveScope({
      cwd: repo.root,
      spec: { kind: "project" },
      maxFileTokens: 500,
    });
    expect(all.files.map((f) => f.path)).not.toContain("src/big.ts");
    expect(all.skipped).toContainEqual({ path: "src/big.ts", reason: "larger than 500 tokens" });
    expect(all.skipped.map((x) => x.path)).toEqual(
      expect.arrayContaining(["docs/guide.md", "src/api/a.svg"]),
    );
    const named = await resolveScope({
      cwd: repo.root,
      spec: { kind: "paths", paths: ["src/big.ts", "docs/guide.md", "src/api"], diff: false },
      maxFileTokens: 500,
    });
    expect(paths(named)).toEqual([
      "docs/guide.md",
      "src/api/payments.ts",
      "src/api/webhooks.ts",
      "src/big.ts",
    ]);
    expect(named.skipped).toEqual([
      { path: "src/api/a.svg", reason: "docs, assets or generated (default ignore)" },
    ]);
    const secret = await resolveScope({
      cwd: repo.root,
      spec: { kind: "paths", paths: ["pnpm-lock.yaml"], diff: false },
    });
    expect(secret.files).toEqual([]);
  });
});

describe("git helpers", () => {
  it("fails outside a repository and reports git errors", async () => {
    await expect(repoRoot("/")).rejects.toThrow(/not inside a git repository/);
    const err = await git(repo.root, ["rev-parse", "nope-ref"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).message).toMatch(/git rev-parse nope-ref failed/);
  });

  it("passes stdin through", async () => {
    const sha = await git(repo.root, ["hash-object", "--stdin"], "hello\n");
    expect(sha.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("matches nothing for an empty matcher list", () => {
    expect(pathMatcher(repo.root, repo.root, [])("a")).toBe(false);
  });
});
