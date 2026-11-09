import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelInfo } from "@crit/providers";
import { createFixtureRepo, type FixtureRepo } from "@crit/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { fakeProvidersJson, type TestEnv, testContext } from "./helpers.ts";

const MODELS: ModelInfo[] = Array.from({ length: 15 }, (_, i) => ({
  id: `model-${String(i + 1).padStart(2, "0")}`,
  label: `Model ${i + 1}`,
  efforts: i < 10 ? ["low", "high"] : ["low", "medium", "high", "xhigh"],
  defaultEffort: "low",
}));
const SHORT: ModelInfo[] = MODELS.slice(0, 3);
const saved = (t: TestEnv) =>
  JSON.parse(readFileSync(join(t.ctx.paths.config, "providers.json"), "utf8"));
const okScript = { runs: [{ match: { kind: "answer" }, message: "ok", repeat: true }] };

let t: TestEnv;
let repo: FixtureRepo | undefined;
afterEach(() => {
  t?.cleanup();
  repo?.cleanup();
  repo = undefined;
});

describe("crit providers models", () => {
  it("lists what the CLI offers, marks the current model, and filters with --search", async () => {
    t = testContext({ models: MODELS });
    fakeProvidersJson(t, {
      providers: [
        {
          name: "agent",
          type: "test-agent",
          command: "test-agent",
          model: "model-02",
          enabled: true,
        },
      ],
    });
    expect(await t.run("providers", "models", "agent")).toBe(0);
    const out = t.stdout();
    expect(out).toMatch(/● +model-02\s+Model 2\s+low high \(default low\)/);
    expect(out).toMatch(/ {2}model-12\s+Model 12\s+low medium high xhigh \(default low\)/);
    expect(out).toContain("15 models · crit providers edit agent --model <id>");

    t.ctx.out("\n--search\n");
    expect(await t.run("providers", "models", "agent", "--search", "model 1")).toBe(0);
    const part = t.stdout().split("--search\n")[1]!;
    expect(part).toContain("model-10");
    expect(part).not.toContain("model-02 ");
    expect(part).toContain("7 of 15 models");
  });

  it("works with the default profile, with a provider type before it is added, and as JSON", async () => {
    t = testContext({ models: SHORT });
    fakeProvidersJson(t);
    expect(await t.run("providers", "models")).toBe(0);
    expect(t.stdout()).toContain("model-01");
    const bare = testContext({ models: SHORT });
    expect(await bare.run("providers", "models", "test-agent", "--json")).toBe(0);
    expect(JSON.parse(bare.stdout())).toMatchObject({
      provider: null,
      type: "test-agent",
      live: true,
      current: null,
    });
    expect(JSON.parse(bare.stdout()).models).toHaveLength(3);
    bare.cleanup();
  });

  it("says when the CLI listed nothing and falls back to the built-in list; rejects unknown targets", async () => {
    t = testContext();
    fakeProvidersJson(t);
    expect(await t.run("providers", "models", "agent")).toBe(0);
    expect(t.stdout()).toContain("fake-small");
    expect(t.stdout()).toContain("(built-in list; the CLI did not list its own)");
    expect(await t.run("providers", "models", "nope")).toBe(1);
    expect(t.stderr()).toContain("nope is not a provider name or type");
  });
});

describe("choosing models, effort and a cheaper model", () => {
  it("add: lists models with search above 12, asks only for efforts the model supports, and saves everything", async () => {
    t = testContext({
      interactive: true,
      models: MODELS,
      answers: ["test-agent", "work", "model-12", "xhigh", "model-01"],
    });
    t.script(okScript);
    expect(await t.run("providers", "add")).toBe(0);
    const log = t.prompter.log.join("\n");
    expect(log).toContain("spin Loading Test Agent models");
    expect(log).toContain("done 15 Test Agent models");
    expect(log).toContain("? Model for Test Agent (type to search)");
    expect(log).toContain("? Reasoning effort for Test Agent");
    expect(saved(t).providers[0]).toMatchObject({
      name: "work",
      model: "model-12",
      effort: "xhigh",
      fastModel: "model-01",
    });
  });

  it("a short list is a plain select; the CLI default and 'same as main' save null", async () => {
    t = testContext({
      interactive: true,
      models: SHORT,
      answers: ["test-agent", "work", "CLI default", "CLI default", "Same as the main model"],
    });
    t.script(okScript);
    expect(await t.run("providers", "add")).toBe(0);
    expect(t.prompter.log.join("\n")).toContain("? Model for Test Agent\n");
    expect(saved(t).providers[0]).toMatchObject({ model: null, effort: null, fastModel: null });
  });

  it("a type-your-own model name is accepted, and a current model missing from the list is kept as an option", async () => {
    t = testContext({
      interactive: true,
      models: SHORT,
      answers: [
        "test-agent",
        "work",
        "Other…",
        "my-private-model",
        "CLI default",
        "Same as the main model",
      ],
    });
    t.script(okScript);
    expect(await t.run("providers", "add")).toBe(0);
    expect(saved(t).providers[0].model).toBe("my-private-model");

    const e = testContext({
      interactive: true,
      models: SHORT,
      answers: ["my-private-model", "CLI default", "Same as the main model", true, [], false],
    });
    e.ctx.paths = t.ctx.paths;
    e.script(okScript);
    expect(await e.run("providers", "edit", "work")).toBe(0);
    expect(saved(t).providers[0].model).toBe("my-private-model");
    e.cleanup();
  });

  it("flags skip the prompts: add and edit take --model, --effort and --fast-model; 'default' clears them", async () => {
    t = testContext({ models: SHORT });
    t.script(okScript);
    expect(
      await t.run(
        "providers",
        "add",
        "test-agent",
        "--model",
        "model-02",
        "--effort",
        "high",
        "--fast-model",
        "model-01",
      ),
    ).toBe(0);
    expect(saved(t).providers[0]).toMatchObject({
      model: "model-02",
      effort: "high",
      fastModel: "model-01",
    });
    expect(t.prompter.log).toEqual([]);
    expect(
      await t.run("providers", "edit", "agent", "--effort", "default", "--fast-model", "default"),
    ).toBe(0);
    expect(saved(t).providers[0]).toMatchObject({
      model: "model-02",
      effort: null,
      fastModel: null,
    });
  });

  it("the scripted autocomplete picks by value or label", async () => {
    t = testContext({
      interactive: true,
      models: MODELS,
      answers: ["test-agent", "work", "Model 7", "CLI default", "Same as the main model"],
    });
    t.script(okScript);
    expect(await t.run("providers", "add")).toBe(0);
    expect(saved(t).providers[0].model).toBe("model-07");
  });
});

describe("crit review --model and --effort", () => {
  it("apply to this run only: the saved profile is untouched", async () => {
    repo = createFixtureRepo({ "src/a.ts": "export const a = 1;\n" });
    repo.git("checkout", "-q", "-b", "f");
    repo.commit("c", { "src/a.ts": "export const a = 2;\n" });
    t = testContext({ cwd: repo.root });
    fakeProvidersJson(t, {
      providers: [
        {
          name: "agent",
          type: "test-agent",
          command: "test-agent",
          model: "model-01",
          effort: "low",
          enabled: true,
        },
      ],
    });
    t.script({
      runs: [{ match: { kind: "review" }, calls: [{ tool: "finish", args: { summary: "ok" } }] }],
    });
    expect(
      await t.run("review", "--no-tui", "--no-verify", "--model", "model-09", "--effort", "high"),
    ).toBe(0);
    const task = t.fakes.flatMap((f) => f.calls)[0]!.task;
    expect(task).toMatchObject({ model: "model-09", effort: "high" });
    expect(saved(t).providers[0]).toMatchObject({ model: "model-01", effort: "low" });

    t.script({
      runs: [{ match: { kind: "review" }, calls: [{ tool: "finish", args: { summary: "ok" } }] }],
    });
    expect(
      await t.run(
        "review",
        "--no-tui",
        "--no-verify",
        "--no-cache",
        "--model",
        "default",
        "--effort",
        "default",
      ),
    ).toBe(0);
    const last = t.fakes.flatMap((f) => f.calls).at(-1)!.task;
    expect(last.model).toBeUndefined();
    expect(last.effort).toBeUndefined();
  });
});
