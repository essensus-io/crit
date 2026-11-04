import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFixtureRepo, type FixtureRepo } from "@crit/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeProvidersJson, normalize, type TestEnv, testContext } from "./helpers.ts";

let repo: FixtureRepo;
let t: TestEnv;

beforeEach(() => {
  repo = createFixtureRepo({
    "CLAUDE.md":
      "# Shop\n\n## Errors\n\nNever swallow errors.\n\n## Commit messages\n\nUse conventional commits.\n",
    ".cursor/rules/payments.mdc":
      "---\ndescription: Validate money inputs\nglobs: src/api/**\n---\nCheck amounts.\n",
    ".claude/skills/api-design/SKILL.md":
      "---\nname: api-design\ndescription: REST conventions\n---\nPlural nouns.\n",
    "src/api/payments.ts": "export {};\n",
  });
  t = testContext({ cwd: repo.root });
});
afterEach(() => {
  t.cleanup();
  repo.cleanup();
});

describe("crit rules", () => {
  it("lists rules, skills and skipped sections", async () => {
    mkdirSync(join(t.ctx.home, ".claude"), { recursive: true });
    writeFileSync(join(t.ctx.home, ".claude", "CLAUDE.md"), "## Errors\n\nLog errors.\n");
    expect(await t.run("rules")).toBe(0);
    expect(t.stdout()).toMatchInlineSnapshot(`
      "Rules (3)
        ID  LAYER    APPLIES TO  RULE                   SOURCE
        R1  project  src/api/**  Validate money inputs  .cursor/rules/payments.mdc
        R2  project  all files   Errors                 CLAUDE.md §Errors
        R4  global   all files   Errors                 ~/.claude/CLAUDE.md §Errors

      Skills and agents (1, listed by name for the agent)
        R3  api-design  REST conventions  .claude/skills/api-design/SKILL.md

      Conflicts (1)
        "errors": R2 wins over R4 (user > project > global)

      1 section skipped as not about review (crit rules --all to list)
      "
    `);
    expect(await t.run("rules", "--all")).toBe(0);
    expect(t.stdout()).toContain("  - CLAUDE.md §Commit messages");
    expect(await t.run("rules", "--json")).toBe(0);
    expect(t.stdout()).toContain('"conflicts"');
  });

  it("reports rule errors with a failing exit code", async () => {
    repo.write({ ".crit/rules/bad.md": "---\nseverity: huge\n---\nx\n" });
    expect(await t.run("rules")).toBe(1);
    expect(t.stdout()).toContain(".crit/rules/bad.md: invalid frontmatter");
  });

  it("adds rule files and git packs, and imports Cursor user rules", async () => {
    const src = join(t.dir, "mine.md");
    writeFileSync(src, "---\ntitle: Mine\n---\nMy rule.\n");
    expect(await t.run("rules", "add", src)).toBe(0);
    expect(existsSync(join(t.ctx.paths.config, "rules", "mine.md"))).toBe(true);
    expect(await t.run("rules", "add", src)).toBe(1);
    expect(t.stderr()).toContain("already exists");

    const pack = createFixtureRepo({ "naming.md": "---\ntitle: Naming\n---\nUse camelCase.\n" });
    expect(await t.run("rules", "add", `file://${pack.root}`, "--name", "acme")).toBe(0);
    const packs = JSON.parse(readFileSync(join(t.ctx.paths.config, "rules", "packs.json"), "utf8"));
    expect(packs[0]).toMatchObject({ name: "acme", commit: pack.git("rev-parse", "HEAD") });
    expect(await t.run("rules", "add", `file://${pack.root}`, "--name", "acme")).toBe(1);
    expect(await t.run("rules", "add", "not-a-thing")).toBe(2);
    pack.cleanup();

    expect(await t.run("rules", "import", "--cursor", "--text", "Prefer early returns.")).toBe(0);
    expect(
      readFileSync(join(t.ctx.paths.config, "rules", "cursor-user-rules.md"), "utf8"),
    ).toContain("Prefer early returns.");
    expect(await t.run("rules")).toBe(0);
    expect(t.stdout()).toContain("Naming");
    expect(t.stdout()).toContain("Cursor user rules");
  });
});

describe("crit doctor", () => {
  it("reports node, git, sqlite, agent CLIs and config", async () => {
    fakeProvidersJson(t);
    const code = await t.run("doctor");
    const out = normalize(t.stdout(), t);
    expect(out).toMatch(/✓ node {17}v\d+/);
    expect(out).toMatch(/✓ git {18}git version/);
    expect(out).toContain("✓ sqlite");
    expect(out).toContain("1 profiles, default agent");
    expect(code).toBe(0);
  });

  it("flags broken providers.json and runs tests with --test", async () => {
    mkdirSync(t.ctx.paths.config, { recursive: true });
    writeFileSync(join(t.ctx.paths.config, "providers.json"), "{ bad");
    expect(await t.run("doctor")).toBe(1);
    expect(t.stdout()).toContain("✗ providers.json");

    fakeProvidersJson(t);
    t.script({ runs: [{ match: { kind: "answer" }, message: "ok" }] });
    expect(await t.run("doctor", "--test")).toBe(0);
    expect(t.stdout()).toContain("✓ test agent");
  });
});

describe("crit init, help and version", () => {
  it("creates .crit/config.json once", async () => {
    expect(await t.run("init", "--provider", "claude")).toBe(0);
    const cfg = JSON.parse(readFileSync(join(repo.root, ".crit", "config.json"), "utf8"));
    expect(cfg).toMatchObject({
      provider: "claude",
      lenses: ["correctness", "security", "performance", "maintainability"],
    });
    expect(await t.run("init")).toBe(1);
    expect(await t.run("init", "--force")).toBe(0);
  });

  it("prints help, subcommand help and the version", async () => {
    expect(await t.run("--help")).toBe(0);
    expect(t.stdout()).toContain("review");
    expect(t.stdout()).toContain("providers");
    expect(await t.run("review", "--help")).toBe(0);
    expect(t.stdout()).toContain("--fail-on");
    expect(await t.run("providers", "add", "--help")).toBe(0);
    expect(t.stdout()).toContain("--model");
    expect(await t.run("--version")).toBe(0);
    expect(t.stdout()).toMatch(/\d+\.\d+\.\d+\n$/);
    expect(await t.run()).toBe(0);
  });

  it("reports unknown commands as usage errors", async () => {
    expect(await t.run("frobnicate")).toBe(2);
    expect(t.stderr()).toContain("crit --help");
  });
});
