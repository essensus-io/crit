import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFixtureRepo, type FixtureRepo } from "@crit/testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverRules,
  isReviewRelevant,
  loadRules,
  parseRuleFile,
  type RuleFile,
  RuleParseError,
  ruleApplies,
  ruleLabel,
  type RuleSet,
  type RuleTagger,
  splitSections,
} from "../src/rules/index.ts";

const longClaudeMd = `# Shop

Project notes for agents.

## Errors

Never swallow errors in a catch block. Wrap them in HttpError with a status.

## Commit messages

Use conventional commits. Keep the subject under 72 characters.

## Running tests

\`\`\`sh
pnpm test
\`\`\`

## Money

Validate money inputs at the boundary. Amounts are integer cents.
${Array.from({ length: 30 }, (_, i) => `- detail ${i}`).join("\n")}
`;

function write(dir: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
}

describe("splitSections", () => {
  it("splits on the repeated heading depth and drops a lone title", () => {
    const s = splitSections("# Title\n\n## A\n\none\n\n### A.1\n\nsub\n\n## B\n\ntwo\n");
    expect(s).toEqual([
      { title: "A", body: "one\n\n### A.1\n\nsub" },
      { title: "B", body: "two" },
    ]);
  });

  it("keeps a preamble and handles docs without headings", () => {
    expect(splitSections("intro\n\n## A\n\none\n")).toEqual([
      { title: undefined, body: "intro" },
      { title: "A", body: "one" },
    ]);
    expect(splitSections("just text\n")).toEqual([{ title: undefined, body: "just text" }]);
    expect(splitSections("# Only\n\nbody\n")).toEqual([{ title: "Only", body: "body" }]);
  });

  it("uses inline text inside headings", () => {
    expect(splitSections("## Use `zod`\n\nx\n\n## B\n\ny\n")[0]!.title).toBe("Use zod");
  });
});

describe("parseRuleFile", () => {
  const file = (
    kind: RuleFile["kind"],
    path: string,
    content: string,
    layer: RuleFile["layer"] = "project",
  ): RuleFile => ({
    kind,
    path,
    content,
    layer,
  });

  it("splits a long CLAUDE.md into one rule per section and keeps short ones whole", () => {
    const rules = parseRuleFile(file("claude-md", "CLAUDE.md", longClaudeMd));
    expect(rules.map((r) => r.title)).toEqual([
      "CLAUDE.md (intro)",
      "Errors",
      "Commit messages",
      "Running tests",
      "Money",
    ]);
    expect(rules[1]).toMatchObject({ key: "CLAUDE.md#Errors", section: "Errors", scopeDir: "" });
    const nested = parseRuleFile(
      file("claude-md", "src/api/CLAUDE.md", "## A\n\nx\n\n## B\n\ny\n"),
    );
    expect(nested.map((r) => [r.title, r.scopeDir])).toEqual([
      ["A", "src/api"],
      ["B", "src/api"],
    ]);
    const plain = parseRuleFile(file("claude-md", "src/CLAUDE.md", "No headings here.\n"));
    expect(plain[0]).toMatchObject({ title: "CLAUDE.md", scopeDir: "src" });
    expect(parseRuleFile(file("agents-md", "AGENTS.md", "  \n"))).toEqual([]);
  });

  it("reads cursor rule frontmatter", () => {
    const [r] = parseRuleFile(
      file(
        "cursor-rule",
        ".cursor/rules/payments.mdc",
        "---\ndescription: Validate money inputs\nglobs: src/api/**, src/db/**\nalwaysApply: false\n---\nCheck amounts.\n",
      ),
    );
    expect(r).toMatchObject({
      title: "Validate money inputs",
      globs: ["src/api/**", "src/db/**"],
      alwaysApply: false,
    });
    const [always] = parseRuleFile(
      file(
        "cursor-rule",
        ".cursor/rules/x.mdc",
        '---\nglobs: ["a/**"]\nalwaysApply: true\n---\nBody\n',
      ),
    );
    expect(always).toMatchObject({ title: "x", globs: ["a/**"], alwaysApply: true });
    expect(
      parseRuleFile(file("cursor-rule", ".cursor/rules/empty.mdc", "---\ndescription: d\n---\n")),
    ).toEqual([]);
  });

  it("reads skills and agents by name and description", () => {
    const [s] = parseRuleFile(
      file(
        "skill",
        ".claude/skills/api-design/SKILL.md",
        "---\nname: api-design\ndescription: REST conventions\n---\nUse plural nouns.\n",
      ),
    );
    expect(s).toMatchObject({ title: "api-design", description: "REST conventions" });
    const [fallback] = parseRuleFile(
      file("skill", ".claude/skills/naming/SKILL.md", "Body only\n"),
    );
    expect(fallback!.title).toBe("naming");
    const [agent] = parseRuleFile(
      file("claude-agent", ".claude/agents/reviewer.md", "Review stuff\n"),
    );
    expect(agent!.title).toBe("reviewer");
  });

  it("reads crit rules and reports bad frontmatter", () => {
    const [r] = parseRuleFile(
      file(
        "crit-rule",
        ".crit/rules/sql.md",
        '---\nid: no-raw-sql\ntitle: No raw SQL outside the repository layer\nglobs: ["src/**/*.ts", "!src/db/**"]\nlens: security\nseverity: major\n---\nQueries must go through repositories.\n',
      ),
    );
    expect(r).toMatchObject({
      key: ".crit/rules/sql.md#no-raw-sql",
      title: "No raw SQL outside the repository layer",
      globs: ["src/**/*.ts", "!src/db/**"],
      lens: "security",
      severity: "major",
    });
    const [plain] = parseRuleFile(
      file("crit-rule", ".crit/rules/x.md", "---\nalwaysApply: true\n---\nX\n"),
    );
    expect(plain).toMatchObject({ title: "x", alwaysApply: true });
    expect(() =>
      parseRuleFile(file("crit-rule", ".crit/rules/bad.md", "---\nseverity: huge\n---\nX\n")),
    ).toThrow(RuleParseError);
  });
});

describe("isReviewRelevant", () => {
  it("drops commit, PR and setup sections and command-only sections", () => {
    const k = "claude-md" as const;
    expect(
      isReviewRelevant({ kind: k, title: "Commit messages", body: "Use conventional commits." }),
    ).toBe(false);
    expect(isReviewRelevant({ kind: k, title: "PR titles", body: "Short." })).toBe(false);
    expect(isReviewRelevant({ kind: k, title: "Setup", body: "Install node." })).toBe(false);
    expect(isReviewRelevant({ kind: k, title: "Code style tooling", body: "Prettier." })).toBe(
      true,
    );
    expect(isReviewRelevant({ kind: k, title: "Build", body: "```sh\npnpm build\n```" })).toBe(
      false,
    );
    expect(isReviewRelevant({ kind: k, title: "Errors", body: "Never swallow errors." })).toBe(
      true,
    );
    expect(isReviewRelevant({ kind: "crit-rule", title: "Commit messages", body: "x" })).toBe(true);
  });
});

describe("discoverRules", () => {
  let repo: FixtureRepo;
  let home: string;

  beforeEach(() => {
    repo = createFixtureRepo({
      "CLAUDE.md": longClaudeMd,
      "src/api/CLAUDE.md": "Return 422 for validation errors.\n",
      "AGENTS.md": "Prefer small functions.\n",
      ".cursor/rules/payments.mdc":
        "---\ndescription: Validate money inputs at the boundary\nglobs: src/api/**\n---\nCheck refund amounts.\n",
      ".cursorrules": "Legacy rule text.\n",
      ".claude/skills/api-design/SKILL.md":
        "---\nname: api-design\ndescription: REST conventions\n---\nPlural nouns.\n",
      ".claude/agents/reviewer.md":
        "---\nname: reviewer\ndescription: strict reviewer\n---\nBe strict.\n",
      ".github/copilot-instructions.md": "Use async/await.\n",
      "REVIEW.md": "Flag missing tests.\n",
      ".crit/rules/sql.md":
        '---\nid: no-raw-sql\nglobs: ["src/**/*.ts", "!src/db/**"]\n---\nNo raw SQL.\n',
      "docs/team-rules.md": "Team rule from include.\n",
      "node_modules/pkg/CLAUDE.md": "should be skipped\n",
      ".gitignore": "secret/\n",
      "src/api/payments.ts": "export {}\n",
      "src/db/orders.ts": "export {}\n",
    });
    repo.write({
      "secret/CLAUDE.md": "ignored by git\n",
      "untracked/AGENTS.md": "untracked but not ignored\n",
    });
    home = mkdtempSync(join(tmpdir(), "crit-home-"));
    write(home, {
      ".claude/CLAUDE.md": "## Errors\n\nLog errors with context.\n",
      ".claude/skills/tdd/SKILL.md":
        "---\nname: tdd\ndescription: test first\n---\nWrite the test first.\n",
      ".codex/AGENTS.md": "Codex global rule.\n",
      ".codex/skills/perf/SKILL.md": "---\nname: perf\ndescription: perf checks\n---\nMeasure.\n",
      "cfg/rules/mine.md": "---\ntitle: Errors\n---\nThrow typed errors.\n",
      "cfg/rules/packs/acme/README.md": "pack readme\n",
      "cfg/rules/packs/acme/naming.md": "---\ntitle: Naming\n---\nUse camelCase.\n",
    });
  });
  afterEach(() => {
    repo.cleanup();
    rmSync(home, { recursive: true, force: true });
  });

  const discover = (sources?: RuleFile["layer"][]) =>
    discoverRules({
      root: repo.root,
      home,
      configDir: join(home, "cfg"),
      include: ["docs/*.md", "github:acme/x"],
      sources,
    });

  it("finds every source in each layer", async () => {
    const files = await discover();
    expect(files.map((f) => `${f.layer} ${f.kind} ${f.path}`)).toMatchInlineSnapshot(`
      [
        "project claude-agent .claude/agents/reviewer.md",
        "project skill .claude/skills/api-design/SKILL.md",
        "project crit-rule .crit/rules/sql.md",
        "project cursor-rule .cursor/rules/payments.mdc",
        "project cursorrules .cursorrules",
        "project copilot-instructions .github/copilot-instructions.md",
        "project agents-md AGENTS.md",
        "project claude-md CLAUDE.md",
        "project review-md REVIEW.md",
        "project crit-rule docs/team-rules.md",
        "project claude-md src/api/CLAUDE.md",
        "project agents-md untracked/AGENTS.md",
        "global claude-md ~/.claude/CLAUDE.md",
        "global skill ~/.claude/skills/tdd/SKILL.md",
        "global agents-md ~/.codex/AGENTS.md",
        "global skill ~/.codex/skills/perf/SKILL.md",
        "user crit-rule ~/cfg/rules/mine.md",
        "user crit-rule ~/cfg/rules/packs/acme/naming.md",
      ]
    `);
    expect((await discover(["global"])).every((f) => f.layer === "global")).toBe(true);
  });

  it("builds a numbered rule set for a scope", async () => {
    const set = await loadRules({ files: await discover(), scopeFiles: ["src/api/payments.ts"] });
    expect(summary(set)).toMatchInlineSnapshot(`
      {
        "attached": [
          "R1 user Errors (~/cfg/rules/mine.md)",
          "R2 user Naming (~/cfg/rules/packs/acme/naming.md)",
          "R3 project no-raw-sql (.crit/rules/sql.md)",
          "R4 project team-rules (docs/team-rules.md)",
          "R5 project REVIEW.md (REVIEW.md)",
          "R6 project Validate money inputs at the boundary (.cursor/rules/payments.mdc)",
          "R7 project .cursorrules (.cursorrules)",
          "R8 project CLAUDE.md (intro) (CLAUDE.md)",
          "R10 project Money (CLAUDE.md)",
          "R11 project CLAUDE.md (src/api/CLAUDE.md)",
          "R12 project AGENTS.md (AGENTS.md)",
          "R14 project copilot-instructions.md (.github/copilot-instructions.md)",
          "R18 global AGENTS.md (~/.codex/AGENTS.md)",
        ],
        "conflicts": [
          {
            "ruleIds": [
              "R1",
              "R9",
              "R17",
            ],
            "topic": "errors",
            "winner": "R1",
          },
        ],
        "filtered": [
          "Commit messages",
          "Running tests",
        ],
        "listed": [],
        "native": [],
        "skills": [
          "R15 reviewer",
          "R16 api-design",
          "R19 tdd",
          "R20 perf",
        ],
        "unattached": [
          "R13 AGENTS.md",
        ],
      }
    `);
  });
});

function summary(set: RuleSet) {
  return {
    attached: set.attached.map((r) => `${r.id} ${r.layer} ${r.title} (${r.path})`),
    listed: set.listed.map((r) => r.id),
    native: set.native.map((r) => r.id),
    skills: set.skills.map((r) => `${r.id} ${r.title}`),
    filtered: set.filtered.map((r) => r.title),
    conflicts: set.conflicts,
    unattached: set.unattached.map((r) => `${r.id} ${r.title}`),
  };
}

describe("loadRules selection", () => {
  const f = (
    path: string,
    content: string,
    kind: RuleFile["kind"] = "crit-rule",
    layer: RuleFile["layer"] = "project",
  ): RuleFile => ({
    path,
    content,
    kind,
    layer,
  });

  it("attaches by glob (with negation) and by nested folder", async () => {
    const files = [
      f(".crit/rules/sql.md", '---\nglobs: ["src/**/*.ts", "!src/db/**"]\n---\nNo raw SQL.\n'),
      f("src/db/CLAUDE.md", "DB rules.\n", "claude-md"),
    ];
    const inDb = await loadRules({ files, scopeFiles: ["src/db/orders.ts"] });
    expect(inDb.attached.map((r) => r.path)).toEqual(["src/db/CLAUDE.md"]);
    const inApi = await loadRules({ files, scopeFiles: ["src/api/a.ts"] });
    expect(inApi.attached.map((r) => r.path)).toEqual([".crit/rules/sql.md"]);
    expect(ruleApplies({ globs: ["!x/**"], scopeDir: "", alwaysApply: false }, ["y/a"])).toBe(true);
    expect(ruleApplies({ globs: [], scopeDir: "src", alwaysApply: false }, ["src"])).toBe(true);
    expect(ruleApplies({ globs: ["zzz"], scopeDir: "", alwaysApply: true }, [])).toBe(true);
  });

  it("project beats global; deeper folder wins within a layer only when layers differ", async () => {
    const set = await loadRules({
      files: [
        f("~/.claude/CLAUDE.md", "## Errors\n\nGlobal.\n", "claude-md", "global"),
        f(".crit/rules/e.md", "---\ntitle: Errors\n---\nProject.\n"),
      ],
      scopeFiles: ["a.ts"],
    });
    expect(set.attached.map((r) => r.body)).toEqual(["Project."]);
    expect(set.conflicts).toHaveLength(1);
    const same = await loadRules({
      files: [f("a.md", "---\ntitle: X\n---\nA\n"), f("b.md", "---\ntitle: X\n---\nB\n")],
      scopeFiles: ["a.ts"],
    });
    expect(same.conflicts).toEqual([]);
    expect(same.attached).toHaveLength(2);
  });

  it("inlines up to the budget and lists the rest, specific rules first", async () => {
    const big = "x".repeat(4000);
    const set = await loadRules({
      files: [
        f("general.md", `---\ntitle: General\n---\n${big}\n`),
        f("scoped.md", `---\ntitle: Scoped\nglobs: a.ts\n---\n${big}\n`),
      ],
      scopeFiles: ["a.ts"],
      budgetTokens: 1100,
    });
    expect(set.attached.map((r) => r.title)).toEqual(["Scoped"]);
    expect(set.listed.map((r) => r.title)).toEqual(["General"]);
  });

  it("sends native kinds as an index only", async () => {
    const set = await loadRules({
      files: [
        f("CLAUDE.md", "Use zod.\n", "claude-md"),
        f("AGENTS.md", "Use tabs.\n", "agents-md"),
      ],
      scopeFiles: ["a.ts"],
      nativeKinds: ["claude-md"],
    });
    expect(set.native.map((r) => r.path)).toEqual(["CLAUDE.md"]);
    expect(set.attached.map((r) => r.path)).toEqual(["AGENTS.md"]);
  });

  it("honours sources, exclude (path and path#Section) and disabled keys", async () => {
    const files = [
      f("CLAUDE.md", longClaudeMd, "claude-md"),
      f("~/.codex/AGENTS.md", "Global\n", "agents-md", "global"),
      f(".crit/rules/a.md", "A\n"),
      f(".crit/rules/b.md", "B\n"),
    ];
    const set = await loadRules({
      files,
      scopeFiles: ["x.ts"],
      sources: ["project"],
      exclude: ["CLAUDE.md#Money", ".crit/rules/a.md", "CLAUDE.md#errors"],
      disabled: [".crit/rules/b.md"],
    });
    expect(set.attached.map((r) => r.title)).toEqual(["CLAUDE.md (intro)"]);
    const glob = await loadRules({
      files,
      scopeFiles: ["x.ts"],
      exclude: [".crit/rules/*.md", "~/.codex/AGENTS.md"],
    });
    expect(glob.attached.map((r) => r.title)).toEqual(["CLAUDE.md (intro)", "Errors", "Money"]);
  });

  it("collects parse errors without failing the set", async () => {
    const set = await loadRules({
      files: [f("bad.md", "---\nlens: nope\n---\nx\n"), f("ok.md", "ok\n")],
      scopeFiles: ["a"],
    });
    expect(set.errors[0]).toMatch(/^bad\.md: invalid frontmatter/);
    expect(set.attached).toHaveLength(1);
  });

  it("asks the tagger once per section and caches the answer by hash", async () => {
    const store = new Map<string, boolean>();
    const tagCache = {
      get: async (h: string) => store.get(h),
      set: async (h: string, v: boolean) => void store.set(h, v),
    };
    const tagger = vi.fn<RuleTagger>(
      async (sections) => new Map(sections.map((s) => [s.hash, s.title !== "Money"])),
    );
    const files = [f("CLAUDE.md", longClaudeMd, "claude-md")];
    const first = await loadRules({ files, scopeFiles: ["a"], tagger, tagCache });
    expect(first.filtered.map((r) => r.title)).toContain("Money");
    expect(first.attached.map((r) => r.title)).toContain("Commit messages");
    await loadRules({ files, scopeFiles: ["a"], tagger, tagCache });
    expect(tagger).toHaveBeenCalledTimes(1);

    const failing = await loadRules({
      files,
      scopeFiles: ["a"],
      tagger: async () => {
        throw new Error("model down");
      },
    });
    expect(failing.errors).toEqual(["rule tagging failed, using heuristic: model down"]);
    expect(failing.filtered.map((r) => r.title)).toEqual(["Commit messages", "Running tests"]);
  });

  it("labels rules for headers", () => {
    expect(
      ruleLabel({ kind: "claude-md", path: "CLAUDE.md", section: "Errors", title: "Errors" }),
    ).toBe("CLAUDE.md §Errors");
    expect(ruleLabel({ kind: "skill", path: "x", title: "api-design" })).toBe("skill api-design");
    expect(ruleLabel({ kind: "claude-agent", path: "x", title: "rev" })).toBe("agent rev");
    expect(ruleLabel({ kind: "cursor-rule", path: ".cursor/rules/p.mdc", title: "P" })).toBe(
      ".cursor/rules/p.mdc",
    );
  });
});
