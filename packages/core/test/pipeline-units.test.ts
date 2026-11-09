import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Finding, Lens, ResolvedScope, Rule } from "@crit/schema";
import { createFixtureRepo, type FixtureRepo } from "@crit/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  applyPatch,
  checkPatch,
  estimateDurationMs,
  excerpt,
  fingerprint,
  groupKey,
  depthProfile,
  lensGroups,
  planRuns,
  lineCount,
  locateAnchor,
  mergeFindings,
  normalizeCode,
  normalizePatch,
  parseJsonReply,
  planShards,
  reanchor,
  repairPrompt,
  reviewPrompt,
  reviewSystemPrompt,
  skepticPrompt,
  titleSimilarity,
} from "../src/index.ts";
import type { RuleSet } from "../src/rules/select.ts";

const F = (over: Partial<Finding> = {}): Finding => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  reviewId: "r",
  fingerprint: "fp",
  file: "a.ts",
  range: { start: 10, end: 12 },
  anchor: "x",
  severity: "minor",
  category: "correctness",
  title: "Null check missing on user",
  explanation: "short",
  confidence: 0.5,
  ruleIds: [],
  status: "open",
  selected: false,
  mergedFrom: [],
  createdAt: 0,
  ...over,
});

describe("fingerprint and merge", () => {
  it("is stable across whitespace and line moves, but not category or file", () => {
    const a = fingerprint({ file: "a.ts", anchor: "if (x)  {\n  y();", category: "correctness" });
    expect(fingerprint({ file: "a.ts", anchor: "if (x) { y();", category: "correctness" })).toBe(a);
    expect(fingerprint({ file: "a.ts", anchor: "if (x) { y();", category: "security" })).not.toBe(
      a,
    );
    expect(
      fingerprint({ file: "b.ts", anchor: "if (x) { y();", category: "correctness" }),
    ).not.toBe(a);
    expect(normalizeCode("  a \n\t b ")).toBe("a b");
  });

  it("scores title similarity", () => {
    expect(
      titleSimilarity("Null check missing on user", "Missing null check for user"),
    ).toBeGreaterThan(0.5);
    expect(titleSimilarity("SQL injection", "Unused import")).toBe(0);
    expect(titleSimilarity("", "")).toBe(1);
  });

  it("merges duplicates by fingerprint, keeping the most severe and confident", () => {
    const a = F({ id: "a", fingerprint: "1", severity: "minor", ruleIds: ["R1"] });
    const b = F({
      id: "b",
      fingerprint: "1",
      severity: "major",
      ruleIds: ["R2"],
      mergedFrom: ["old"],
    });
    const c = F({ id: "c", fingerprint: "1", severity: "major", confidence: 0.9 });
    const d = F({ id: "d", fingerprint: "2", file: "b.ts" });
    const r = mergeFindings([a, b, c, d]);
    expect(r.removed.sort()).toEqual(["a", "b"]);
    const kept = r.findings.find((f) => f.id === "c")!;
    expect(kept.ruleIds.sort()).toEqual(["R1", "R2"]);
    expect(kept.mergedFrom.sort()).toEqual(["a", "b"]);
    const e1 = F({ id: "e1", fingerprint: "3", explanation: "longer explanation" });
    const e2 = F({ id: "e2", fingerprint: "3" });
    expect(mergeFindings([e2, e1]).findings[0]!.id).toBe("e1");
  });

  it("groups overlapping findings with similar titles in the same file", () => {
    const r = mergeFindings([
      F({ id: "a", fingerprint: "1", range: { start: 10, end: 14 } }),
      F({
        id: "b",
        fingerprint: "2",
        range: { start: 12, end: 20 },
        title: "Missing null check for user",
      }),
      F({
        id: "c",
        fingerprint: "3",
        range: { start: 13, end: 13 },
        title: "Totally different thing",
      }),
      F({ id: "d", fingerprint: "4", range: { start: 50, end: 51 } }),
      F({ id: "e", fingerprint: "5", file: "z.ts", groupId: "stale" }),
    ]);
    const g = Object.fromEntries(r.findings.map((f) => [f.id, f.groupId]));
    expect(g.a).toBe("a");
    expect(g.b).toBe("a");
    expect(g.c).toBeUndefined();
    expect(g.d).toBeUndefined();
    expect(g.e).toBeUndefined();
  });
});

describe("anchors", () => {
  const content = "line one\nconst a = 1;\nfoo();\nconst a = 1;\nbar(\n  x,\n);\n";

  it("finds exact multi-line anchors nearest the reported range", () => {
    expect(locateAnchor(content, "const a = 1;", { start: 4, end: 4 })).toEqual({
      range: { start: 4, end: 4 },
      exact: true,
    });
    expect(locateAnchor(content, "const a = 1;")).toEqual({
      range: { start: 2, end: 2 },
      exact: true,
    });
    expect(locateAnchor(content, "bar(\n  x,\n);")).toEqual({
      range: { start: 5, end: 7 },
      exact: true,
    });
  });

  it("falls back to whitespace-insensitive matching", () => {
    expect(locateAnchor(content, "bar( x, );")?.exact).toBe(false);
    expect(locateAnchor(content, "nope")).toBeUndefined();
    expect(locateAnchor(content, "   ")).toBeUndefined();
  });

  it("re-anchors moved code and reports code that is gone", () => {
    const moved = `new line\n${content}`;
    expect(reanchor(moved, "foo();", { start: 3, end: 3 })).toEqual({ start: 4, end: 4 });
    expect(reanchor(moved, "bar(", { start: 5, end: 7 })).toEqual({ start: 6, end: 8 });
    expect(reanchor("other", "foo();", { start: 3, end: 3 })).toBeUndefined();
  });

  it("counts lines and makes numbered excerpts", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount("a\nb")).toBe(2);
    expect(excerpt(content, { start: 3, end: 3 }, 1)).toBe(
      " 2  const a = 1;\n>3  foo();\n 4  const a = 1;",
    );
  });
});

describe("patches", () => {
  let repo: FixtureRepo;
  beforeEach(() => {
    repo = createFixtureRepo({ "src/a.ts": "const a = 1;\nexport { a };\n" });
  });
  afterEach(() => repo.cleanup());

  const good =
    "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n export { a };\n";

  it("normalizes fences, missing prefixes and trailing newline", () => {
    expect(normalizePatch("```diff\n--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-x\n+y\n```")).toBe(
      "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n",
    );
    expect(normalizePatch("--- /dev/null\n+++ b/n.ts")).toBe("--- /dev/null\n+++ b/n.ts\n");
  });

  it("checks with git apply and reports errors", async () => {
    expect(await checkPatch(repo.root, good)).toEqual({
      ok: true,
      patch: good,
      files: ["src/a.ts"],
    });
    const bad = await checkPatch(repo.root, good.replace("const a = 1;", "const a = 9;"));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/patch failed|does not apply/);
    expect(await checkPatch(repo.root, "just words")).toEqual({
      ok: false,
      error: expect.stringMatching(/not a unified diff/),
    });
    expect(
      (await checkPatch(repo.root, good.replace("@@ -1,2 +1,2 @@", "@@ -1,5 +1,7 @@"))).ok,
    ).toBe(true);
  });

  it("applies and reverses", async () => {
    expect((await applyPatch(repo.root, good)).exitCode).toBe(0);
    expect(repo.git("diff", "--stat")).toContain("src/a.ts");
    expect((await applyPatch(repo.root, good, { reverse: true })).exitCode).toBe(0);
    expect(repo.git("status", "--porcelain")).toBe("");
    expect((await applyPatch(repo.root, good, { check: true })).exitCode).toBe(0);
  });
});

describe("shards", () => {
  let repo: FixtureRepo;
  beforeEach(() => {
    repo = createFixtureRepo({ "packages/api/package.json": "{}" });
  });
  afterEach(() => repo.cleanup());

  const scopeOf = (files: [string, number][], diff?: string): ResolvedScope => ({
    spec: { kind: "project" },
    label: "whole project",
    root: repo.root,
    files: files.map(([path, size]) => ({ path, status: "unchanged" as const, size })),
    ignored: [],
    skipped: [],
    ...(diff ? { diff } : {}),
  });

  it("keeps a small scope in one shard", () => {
    const s = planShards(
      scopeOf([
        ["a.ts", 400],
        ["b.ts", 400],
      ]),
      1000,
    );
    expect(s).toEqual([{ label: "whole project", files: ["a.ts", "b.ts"], estimatedTokens: 200 }]);
    expect(planShards(scopeOf([]), 1000)).toEqual([]);
  });

  it("groups by package marker or top-level folder, packs small groups, splits big ones", () => {
    mkdirSync(join(repo.root, "packages/api/src"), { recursive: true });
    expect(groupKey(repo.root, "packages/api/src/x.ts")).toBe("packages/api");
    expect(groupKey(repo.root, "docs/a.md")).toBe("docs");
    expect(groupKey(repo.root, "README.md")).toBe(".");
    const s = planShards(
      scopeOf([
        ["packages/api/src/a.ts", 2400],
        ["packages/api/src/b.ts", 2400],
        ["packages/api/src/c.ts", 2400],
        ["docs/a.md", 400],
        ["README.md", 400],
        ["scripts/x.sh", 400],
      ]),
      1500,
    );
    expect(s.map((x) => [x.label, x.files.length, x.estimatedTokens])).toEqual([
      ["., docs, scripts", 3, 300],
      ["packages/api (1/2)", 2, 1200],
      ["packages/api (2/2)", 1, 600],
    ]);
  });

  it("counts diff text in the estimate and skips deleted files", () => {
    const diff = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-${"x".repeat(400)}\n+y\n`;
    const scope = scopeOf([["a.ts", 0]], diff);
    scope.files.push({ path: "gone.ts", status: "deleted", size: 0 });
    const [only] = planShards(scope, 100_000);
    expect(only!.files).toEqual(["a.ts"]);
    expect(only!.estimatedTokens).toBeGreaterThan(100);
  });

  it("splits lenses only at deep depth and only for big shards; estimates time", () => {
    const all = ["correctness", "security", "performance", "maintainability"] as const;
    expect(lensGroups([...all], 1000, 900)).toEqual([[...all]]);
    expect(lensGroups([...all], 1000, 100, true)).toEqual([[...all]]);
    expect(lensGroups([...all], 1000, 900, true)).toEqual([
      ["correctness", "security"],
      ["performance", "maintainability"],
    ]);
    expect(lensGroups(["security", "style"], 1000, 900, true)).toEqual([["security", "style"]]);
    expect(lensGroups(["performance", "style", "maintainability"], 1000, 900, true)).toEqual([
      ["performance", "style", "maintainability"],
    ]);
    expect(estimateDurationMs(12, 3, 1000)).toBe(4000);
    expect(estimateDurationMs(1, 0, 1000)).toBe(1000);
  });

  it("depth profiles: quick = core lenses, standard = one pass, deep = split + check all", () => {
    const lenses = ["correctness", "security", "performance", "maintainability"] as const;
    expect(depthProfile({ lenses: [...lenses], depth: "quick" })).toEqual({
      lenses: ["correctness", "security"],
      split: false,
      skeptic: "off",
    });
    expect(depthProfile({ lenses: ["style"], depth: "quick" }).lenses).toEqual([
      "correctness",
      "security",
    ]);
    expect(depthProfile({ lenses: [...lenses], depth: "standard" })).toMatchObject({
      split: false,
      skeptic: "no-nits",
    });
    expect(depthProfile({ lenses: [...lenses], depth: "deep" })).toMatchObject({
      split: true,
      skeptic: "all",
    });
  });

  it("planRuns: one run per shard by default, two per big shard at deep", () => {
    const scope = {
      spec: { kind: "project" },
      label: "whole project",
      root: "/nonexistent",
      files: [{ path: "a.ts", status: "unchanged", size: 3200 }],
      ignored: [],
      skipped: [],
    } as unknown as ResolvedScope;
    const cfg = {
      shardTokens: 1000,
      lenses: ["correctness", "security", "performance", "maintainability"] as Lens[],
    };
    expect(planRuns(scope, { ...cfg, depth: "standard" })).toHaveLength(1);
    expect(planRuns(scope, { ...cfg, depth: "deep" }).map((r) => r.lenses)).toEqual([
      ["correctness", "security"],
      ["performance", "maintainability"],
    ]);
    expect(planRuns(scope, { ...cfg, depth: "quick" })[0]!.lenses).toEqual([
      "correctness",
      "security",
    ]);
  });
});

describe("prompts", () => {
  const rule = (id: string, over: Partial<Rule> = {}): Rule => ({
    id,
    key: id,
    title: `Rule ${id}`,
    body: `Body ${id}`,
    layer: "project",
    kind: "crit-rule",
    path: `.crit/rules/${id}.md`,
    globs: [],
    scopeDir: "",
    alwaysApply: false,
    reviewRelevant: true,
    hash: id,
    ...over,
  });
  const rules: RuleSet = {
    all: [],
    attached: [rule("R1", { globs: ["src/**"] })],
    listed: [rule("R2")],
    native: [rule("R3", { kind: "claude-md", path: "CLAUDE.md" })],
    skills: [rule("R4", { kind: "skill", title: "api-design", description: "REST" })],
    filtered: [],
    conflicts: [{ topic: "errors", ruleIds: ["R1", "R5"], winner: "R1" }],
    unattached: [],
    errors: [],
  };
  const diff =
    "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-a\n+b\n+c\ndiff --git a/src/big.ts b/src/big.ts\n--- a/src/big.ts\n+++ b/src/big.ts\n@@ -1 +1 @@\n-x\n+" +
    "y".repeat(500) +
    "\n";
  const scope: ResolvedScope = {
    spec: { kind: "branch" },
    label: "feature → main",
    root: "/r",
    baseRef: "main",
    files: [
      { path: "src/a.ts", status: "modified", size: 3, hunks: [{ start: 1, lines: 2 }] },
      { path: "src/big.ts", status: "modified", size: 3, hunks: [{ start: 1, lines: 1 }] },
      { path: "other.ts", status: "modified", size: 3, hunks: [] },
    ],
    diff,
    ignored: [],
    skipped: [],
  };

  it("builds the shard prompt with scope, diff, rules, skills and conflicts", () => {
    const p = reviewPrompt({
      scope,
      files: ["src/a.ts", "src/big.ts"],
      lenses: ["security"],
      rules,
      repoSummary: "A shop.",
      diffBudgetChars: 300,
    });
    expect(p).toContain("Review scope: feature → main (base main).");
    expect(p).toContain("- security: Injection");
    expect(p).toContain("Repository overview:\nA shop.");
    expect(p).toContain("- src/a.ts (modified) lines 1-2");
    expect(p).toContain("- src/big.ts (modified) lines 1");
    expect(p).not.toContain("other.ts");
    expect(p).toContain("+c\n");
    expect(p).toContain(
      "Diff omitted for size (read these files and run git diff yourself): src/big.ts",
    );
    expect(p).toContain("### R1 Rule R1\nSource: .crit/rules/R1.md (applies to src/**)");
    expect(p).toContain("- R2 Rule R2 (.crit/rules/R2.md)\n- R3 Rule R3 (CLAUDE.md)");
    expect(p).toContain("- R4 api-design: REST");
    expect(p).toContain("R1 over R5");
    const plain = reviewPrompt({
      scope: { ...scope, diff: undefined, baseRef: undefined } as ResolvedScope,
      files: ["src/a.ts"],
      lenses: ["style"],
      rules: { ...rules, attached: [], listed: [], native: [], skills: [], conflicts: [] },
    });
    expect(plain).toContain("Report on any line of these files.");
    expect(plain).not.toContain("Review rules");
  });

  it("switches reporting instructions for MCP and JSON fallback", () => {
    expect(reviewSystemPrompt({ mcp: true })).toContain("ONE report_findings call");
    expect(reviewSystemPrompt({ mcp: false })).toContain(
      '{"findings": [<finding>, ...], "summary": "<one paragraph>"}',
    );
  });

  it("embeds findings in a parseable block for the skeptic", () => {
    const p = skepticPrompt([{ finding: F({ id: "f1", title: "T" }), excerpt: ">1 x" }]);
    const block = /<findings>\n([\s\S]*)\n<\/findings>/.exec(p)![1]!;
    expect(JSON.parse(block)[0]).toMatchObject({
      id: "f1",
      title: "T",
      lines: "10-12",
      code: ">1 x",
    });
  });

  it("parses JSON replies with fences, prose and errors", () => {
    const S = z.object({ a: z.number() });
    expect(parseJsonReply('Here:\n```json\n{"a": 1}\n```', S)).toEqual({
      ok: true,
      data: { a: 1 },
    });
    expect(parseJsonReply('ok {"a": 2} done', S)).toEqual({ ok: true, data: { a: 2 } });
    expect(parseJsonReply("nothing", S)).toEqual({
      ok: false,
      error: "no JSON object found in the reply",
    });
    expect(parseJsonReply("{a:}", S).ok).toBe(false);
    expect(parseJsonReply('{"a":"x"}', S)).toEqual({
      ok: false,
      error: expect.stringMatching(/^a: /),
    });
    expect(parseJsonReply("[]x{}", z.array(z.number()))).toEqual({
      ok: false,
      error: expect.stringMatching(/^\(root\)/),
    });
    expect(repairPrompt("bad")).toContain("could not be used: bad");
  });
});
