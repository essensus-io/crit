import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFixtureRepo, type FixtureRepo } from "@crit/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { fakeProvidersJson, normalize, type TestEnv, testContext } from "./helpers.ts";
import { chooseReviewProvider } from "@/commands/providers.ts";

const posix = process.platform !== "win32";
let t: TestEnv;
let repo: FixtureRepo | undefined;

afterEach(() => {
  t?.cleanup();
  repo?.cleanup();
  repo = undefined;
});

const saved = (env: TestEnv) =>
  JSON.parse(readFileSync(join(env.ctx.paths.config, "providers.json"), "utf8"));
const okScript = { runs: [{ match: { kind: "answer" }, message: "ok", repeat: true }] };

describe("review provider recovery", () => {
  it("selects an existing provider", async () => {
    t = testContext({ interactive: true, answers: ["agent"] });
    fakeProvidersJson(t);
    expect(await chooseReviewProvider(t.ctx)).toBe("agent");
  });

  it("connects and tests another provider without replacing the default", async () => {
    t = testContext({
      interactive: true,
      answers: ["__add__", "test-agent", "backup", "__cli_default__"],
    });
    fakeProvidersJson(t);
    t.script(okScript);
    expect(await chooseReviewProvider(t.ctx)).toBe("backup");
    expect(saved(t).default).toBe("agent");
    expect(saved(t).providers.map((p: { name: string }) => p.name)).toEqual(["agent", "backup"]);
    expect(t.stderr()).toContain("backup replied");
  });
});

describe.skipIf(!posix)("first run", () => {
  it("detects agents, adds the chosen ones, tests them and continues the command", async () => {
    repo = createFixtureRepo({ "a.ts": "export const a = 1;\n" });
    repo.git("checkout", "-q", "-b", "f");
    repo.commit("c", { "a.ts": "export const a = 2;\n" });
    t = testContext({
      cwd: repo.root,
      interactive: true,
      answers: [["test-agent"], "claude", "fake-large"],
    });
    t.script({
      runs: [
        { match: { kind: "answer" }, message: "ok" },
        { match: { kind: "review" }, calls: [{ tool: "finish", args: { summary: "clean" } }] },
      ],
    });
    expect(await t.run("review", "--no-tui", "--no-verify")).toBe(0);
    expect(normalize(t.prompter.log.join("\n"), t)).toMatchInlineSnapshot(`
      "intro crit · first run: let's add a provider
      note Agent CLIs on your PATH: ✓ test-agent     <tmp>/bin/test-agent (1.2.3)
      ? Which providers do you want to add?
      ? Name for Test Agent
      ? Model for Test Agent
      ? Reasoning effort for Test Agent
      ? Cheaper model for Test Agent's skeptic and repo map
      spin Testing providers
      done Testing providers
      ✓ claude     replied in <dur>
      outro Saved 1 provider to <tmp>/crit/config/providers.json · continuing: crit review"
    `);
    expect(saved(t)).toMatchObject({
      default: "claude",
      providers: [
        {
          name: "claude",
          type: "test-agent",
          command: `${t.dir}/bin/test-agent`,
          model: "fake-large",
          enabled: true,
        },
      ],
    });
    expect(t.stdout()).toContain("No findings.");
  });

  it("shows the fix when a provider test fails", async () => {
    t = testContext({ interactive: true, answers: [["test-agent"], "agent", "CLI default"] });
    t.script({
      runs: [
        {
          match: { kind: "answer" },
          events: [{ type: "error", message: "Not logged in" }],
          exitCode: 1,
        },
      ],
    });
    expect(await t.run("providers", "add")).toBe(0);
    const log = t.prompter.log.join("\n");
    expect(log).toContain("fail Testing providers");
    expect(log).toContain(
      "✗ agent      not logged in · run `test-agent login`, then `crit providers test agent`",
    );
    expect(saved(t).providers[0].model).toBeNull();
  });

  it("stops when no agent CLI is installed", async () => {
    t = testContext({ interactive: true });
    t.ctx.env.PATH = join(t.dir, "nothing");
    expect(await t.run("providers", "add")).toBe(1);
    expect(t.stderr()).toContain("no supported agent CLI found on your PATH");
    expect(t.stderr()).toContain("Test Agent (test-agent)");
  });

  it("can be cancelled", async () => {
    t = testContext({ interactive: true, answers: ["__cancel__"] });
    expect(await t.run("providers", "add")).toBe(130);
    expect(t.stderr()).toBe("Cancelled.\n");
  });
});

describe("crit providers", () => {
  it("lists profiles with status, default and roles", async () => {
    t = testContext();
    expect(await t.run("providers")).toBe(0);
    expect(t.stdout()).toContain("No providers yet");
    fakeProvidersJson(t, {
      providers: [
        { name: "agent", type: "test-agent", command: "test-agent", model: "opus", enabled: true },
        {
          name: "second",
          type: "test-agent",
          command: "missing-agent",
          model: null,
          enabled: true,
        },
        { name: "off", type: "test-agent", command: "test-agent", model: null, enabled: false },
        { name: "weird", type: "opencode", command: "opencode", model: null, enabled: true },
      ],
      roles: { skeptic: "second" },
    });
    expect(await t.run("providers", "list")).toBe(0);
    expect(t.stdout().split("set one up.\n")[1]).toMatchInlineSnapshot(`
      "
          NAME    TYPE        MODEL        STATUS
        ● agent   test-agent  opus         ready (0.0.0-fake)     default
          second  test-agent  CLI default  not installed
          off     test-agent  CLI default  disabled
          weird   opencode    CLI default  unknown type opencode

        roles   review → agent · skeptic → second · evaluate → agent

      "
    `);
  });

  it("adds with flags (no prompts) and refuses duplicates and unknown types", async () => {
    t = testContext();
    t.script(okScript);
    expect(await t.run("providers", "add", "test-agent", "--model", "fake-small", "--test")).toBe(
      0,
    );
    expect(t.stderr()).toMatch(/✓ agent replied in/);
    expect(
      await t.run(
        "providers",
        "add",
        "test-agent",
        "--name",
        "fast",
        "--model",
        "default",
        "--default",
      ),
    ).toBe(0);
    expect(saved(t)).toMatchObject({
      default: "fast",
      providers: [
        { name: "agent", model: "fake-small" },
        { name: "fast", model: null },
      ],
    });
    expect(await t.run("providers", "add", "test-agent", "--name", "fast")).toBe(1);
    expect(t.stderr()).toContain('a provider named "fast" already exists');
    expect(await t.run("providers", "add", "opencode")).toBe(2);
    expect(await t.run("providers", "add")).toBe(2);
    expect(t.stderr()).toContain("pass a provider type");
    expect(await t.run("providers", "add", "test-agent")).toBe(0);
    expect(saved(t).providers.map((p: { name: string }) => p.name)).toEqual([
      "agent",
      "fast",
      "agent-2",
    ]);
  });

  it("adds interactively when providers already exist", async () => {
    t = testContext({ interactive: true, answers: ["test-agent", "second", "Other…", "my-model"] });
    fakeProvidersJson(t);
    t.script(okScript);
    expect(await t.run("providers", "add")).toBe(0);
    expect(saved(t).providers[1]).toMatchObject({ name: "second", model: "my-model" });
  });

  it("edits model, enabled and roles, with flags or prompts", async () => {
    t = testContext();
    fakeProvidersJson(t, {
      providers: [
        { name: "agent", type: "test-agent", command: "test-agent", model: null, enabled: true },
        { name: "codex", type: "test-agent", command: "test-agent", model: null, enabled: true },
      ],
    });
    expect(
      await t.run("providers", "edit", "codex", "--model", "fake-large", "--roles", "skeptic"),
    ).toBe(0);
    expect(saved(t)).toMatchObject({
      roles: { skeptic: "codex" },
      providers: [{}, { model: "fake-large" }],
    });
    expect(await t.run("providers", "edit", "codex", "--roles", "")).toBe(0);
    expect(saved(t).roles).toEqual({});
    expect(await t.run("providers", "edit", "codex", "--roles", "boss")).toBe(2);
    expect(await t.run("providers", "edit", "agent", "--no-enabled")).toBe(1);
    expect(t.stderr()).toContain("choose another default before disabling it");
    expect(await t.run("providers", "edit", "ghost")).toBe(1);

    const i = testContext({
      interactive: true,
      answers: ["CLI default", "low", "fake-small", false, ["evaluate"], true],
    });
    i.ctx.paths = t.ctx.paths;
    i.script(okScript);
    expect(await i.run("providers", "edit", "codex")).toBe(0);
    expect(saved(t)).toMatchObject({
      roles: { evaluate: "codex" },
      providers: [{}, { model: null, effort: "low", fastModel: "fake-small", enabled: false }],
    });
    expect(i.prompter.log.join("\n")).toMatch(/success replied in/);
    i.cleanup();
  });

  it("removes profiles and picks a new default", async () => {
    t = testContext();
    fakeProvidersJson(t, {
      providers: [
        { name: "agent", type: "test-agent", command: "test-agent", model: null, enabled: true },
        { name: "b", type: "test-agent", command: "test-agent", model: null, enabled: true },
        { name: "c", type: "test-agent", command: "test-agent", model: null, enabled: true },
      ],
      roles: { skeptic: "agent" },
    });
    expect(await t.run("providers", "remove", "agent")).toBe(2);
    expect(await t.run("providers", "remove", "agent", "--yes")).toBe(2);
    expect(t.stderr()).toContain("pass --default <name>");
    expect(await t.run("providers", "remove", "agent", "--yes", "--default", "c")).toBe(0);
    expect(t.stdout()).toContain("Removed agent · default is now c · cleared roles skeptic");
    expect(await t.run("providers", "remove", "b", "-y")).toBe(0);

    const i = testContext({ interactive: true, answers: [true] });
    i.ctx.paths = t.ctx.paths;
    expect(await i.run("providers", "remove", "c")).toBe(0);
    expect(saved(t)).toMatchObject({ default: null, providers: [] });
    const no = testContext({ interactive: true, answers: [false] });
    fakeProvidersJson(no);
    expect(await no.run("providers", "remove", "agent")).toBe(130);
    no.cleanup();
    i.cleanup();
  });

  it("asks for a new default interactively when removing the default", async () => {
    t = testContext({ interactive: true, answers: [true, "c"] });
    fakeProvidersJson(t, {
      providers: ["agent", "b", "c"].map((name) => ({
        name,
        type: "test-agent",
        command: "test-agent",
        model: null,
        enabled: true,
      })),
    });
    expect(await t.run("providers", "remove", "agent")).toBe(0);
    expect(saved(t).default).toBe("c");
    expect(t.prompter.log).toContain("? agent is your default. Remove it?");
  });

  it("sets the default and roles, and tests providers", async () => {
    t = testContext();
    fakeProvidersJson(t, {
      providers: [
        { name: "agent", type: "test-agent", command: "test-agent", model: null, enabled: true },
        { name: "b", type: "test-agent", command: "missing-agent", model: null, enabled: true },
      ],
    });
    expect(await t.run("providers", "default", "b")).toBe(0);
    expect(saved(t).default).toBe("b");
    expect(await t.run("providers", "role", "skeptic", "agent")).toBe(0);
    expect(saved(t).roles).toEqual({ skeptic: "agent" });
    expect(await t.run("providers", "role", "skeptic")).toBe(0);
    expect(saved(t).roles).toEqual({});
    expect(await t.run("providers", "role", "boss", "agent")).toBe(2);

    t.script(okScript);
    expect(await t.run("providers", "test", "agent")).toBe(0);
    expect(t.stdout()).toMatch(/✓ agent {8}replied in/);
    expect(await t.run("providers", "test")).toBe(1);
    expect(t.stdout()).toContain(
      "✗ b            missing-agent not found · install it or fix the command with `crit providers edit b`",
    );

    t.script({
      runs: [{ match: { kind: "answer" }, events: [{ type: "rate-limited" }], exitCode: 1 }],
    });
    expect(await t.run("providers", "test", "agent")).toBe(1);
    expect(t.stdout()).toContain("rate limited, try again later");
  });

  it("errors on testing with no providers", async () => {
    t = testContext();
    expect(await t.run("providers", "test")).toBe(1);
    expect(t.stderr()).toContain("no providers to test");
  });
});
