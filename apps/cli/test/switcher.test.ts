import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, type ProvidersFile } from "@crit/schema";
import { loadProviders, saveProviders } from "@crit/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Choice,
  createSwitcher,
  describeChoice,
  describeChoiceParts,
} from "../src/tui/features/model-switching/index.ts";
import { summaryLine } from "../src/tui/app/index.ts";
import { fakeProvidersJson, type TestEnv, testContext } from "./helpers.ts";

let t: TestEnv;
afterEach(() => t?.cleanup());

const FILE: ProvidersFile = {
  default: "a",
  providers: [
    {
      name: "a",
      type: "test-agent",
      command: "test-agent",
      model: "m1",
      effort: "low",
      enabled: true,
    },
    {
      name: "b",
      type: "test-agent",
      command: "test-agent",
      model: null,
      effort: null,
      enabled: true,
    },
    { name: "off", type: "test-agent", command: "test-agent", model: null, enabled: false },
  ],
  roles: {},
};
const MODELS = [
  { id: "m1", label: "M1", efforts: ["low", "high"] },
  { id: "m2", label: "M2", efforts: ["low", "medium", "high", "xhigh"] },
];

describe("createSwitcher", () => {
  it("starts from the profile, lists enabled providers, and reports every change", () => {
    t = testContext({ models: MODELS });
    const seen: string[] = [];
    const sw = createSwitcher(t.ctx, FILE, { depth: "standard" }, { provider: "a" }, (c) =>
      seen.push(describeChoice(c)),
    );
    expect(sw.current()).toEqual({ provider: "a", model: "m1", effort: "low", depth: "standard" });
    expect(sw.providers().map((p) => p.name)).toEqual(["a", "b"]);
    const sub = vi.fn<(c: Choice) => void>();
    const off = sw.subscribe(sub);
    sw.setModel("m2");
    sw.setEffort("high");
    sw.setDepth("deep");
    off();
    sw.setDepth("quick");
    expect(sub).toHaveBeenCalledTimes(3);
    expect(seen).toEqual([
      "a · m2 · effort low · standard",
      "a · m2 · effort high · standard",
      "a · m2 · effort high · deep",
      "a · m2 · effort high · quick",
    ]);
  });

  it("switching provider takes that profile's model and effort; explicit initial values win", () => {
    t = testContext({ models: MODELS });
    const sw = createSwitcher(
      t.ctx,
      FILE,
      { depth: "standard" },
      { provider: "a", model: "m2", effort: null, depth: "deep" },
    );
    expect(sw.current()).toEqual({ provider: "a", model: "m2", effort: null, depth: "deep" });
    expect(sw.setProvider("b")).toEqual({
      provider: "b",
      model: null,
      effort: null,
      depth: "deep",
    });
    expect(sw.setProvider("a")).toMatchObject({ model: "m1", effort: "low" });
  });

  it("offers the CLI's models and only the efforts the chosen model supports", async () => {
    t = testContext({ models: MODELS });
    const sw = createSwitcher(t.ctx, FILE, { depth: "standard" }, { provider: "a" });
    expect((await sw.models()).models.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(await sw.efforts()).toEqual(["low", "high"]);
    sw.setModel("m2");
    expect(await sw.efforts()).toEqual(["low", "medium", "high", "xhigh"]);
    sw.setModel(null);
    expect((await sw.efforts()).length).toBeGreaterThan(0);
  });

  it("falls back to the factory's efforts and an empty list for unknown providers", async () => {
    t = testContext();
    const sw = createSwitcher(t.ctx, FILE, { depth: "standard" }, { provider: "a" });
    expect((await sw.models()).live).toBe(false);
    expect(await sw.efforts()).toEqual(["low", "high"]);
    const ghost = createSwitcher(t.ctx, FILE, { depth: "standard" }, { provider: "ghost" });
    expect(await ghost.models()).toEqual({ models: [], live: false });
    expect(await ghost.efforts()).toEqual([]);
  });

  it("save writes provider, model and effort back to providers.json without clobbering other edits", () => {
    t = testContext({ models: MODELS });
    fakeProvidersJson(t, {
      default: "a",
      providers: [
        {
          name: "a",
          type: "test-agent",
          command: "test-agent",
          model: "m1",
          effort: "low",
          enabled: true,
        },
        { name: "b", type: "test-agent", command: "test-agent", model: null, enabled: true },
      ],
    });
    const sw = createSwitcher(t.ctx, FILE, { depth: "standard" }, { provider: "a" });
    const onDisk = loadProviders(t.ctx.paths)!;
    saveProviders(t.ctx.paths, { ...onDisk, roles: { skeptic: "b" } });
    sw.setModel("m2");
    sw.setEffort("xhigh");
    expect(sw.save()).toBe("a");
    const saved = JSON.parse(readFileSync(join(t.ctx.paths.config, "providers.json"), "utf8"));
    expect(saved.roles).toEqual({ skeptic: "b" });
    expect(saved.providers[0]).toMatchObject({ name: "a", model: "m2", effort: "xhigh" });
  });

  it("describes a choice for the status bar", () => {
    expect(
      describeChoiceParts({ provider: "a", model: null, effort: null, depth: "deep" }),
    ).toEqual([
      { k: "provider", v: "a", tone: "lav" },
      { k: "model", v: "default", tone: "lav" },
      { k: "effort", v: "default", tone: "orange" },
      { k: "depth", v: "deep", tone: "orange" },
    ]);
    expect(DEFAULT_CONFIG.depth).toBe("standard");
  });
});

describe("summaryLine", () => {
  it("is the one line left after the screen closes, or nothing for an unknown review", async () => {
    t = testContext();
    const store = t.ctx.openStore();
    expect(await summaryLine(store, "missing")).toBeUndefined();
    const repo = await store.repos.upsert({ root: "/r", remoteUrl: null, name: "r" });
    const review = await store.reviews.create({
      id: "01a1a705-0b84-73d2-beba-937078af0454",
      repoId: repo.id,
      scope: { kind: "branch" },
      scopeLabel: "feature → main",
      branch: "feature",
      baseSha: null,
      headSha: null,
      provider: "agent",
      model: null,
      lenses: ["correctness"],
      status: "partial",
      supersededBy: null,
      summary: null,
      rulesHeader: null,
      startedAt: 1,
      finishedAt: 2,
    });
    await store.shards.create({
      id: "s",
      reviewId: review.id,
      label: "x",
      files: [],
      lenses: ["correctness"],
      status: "done",
      estimatedTokens: 1,
      inputTokens: 5000,
      cachedTokens: 0,
      outputTokens: 500,
      durationMs: 1,
      agentSessionId: null,
      summary: null,
      error: null,
    });
    const line = (await summaryLine(store, review.id))!;
    expect(line).toBe(
      `crit review 0454 (stopped early) · feature → main · 0 findings, 0 selected · ~6k tokens · crit open 0454 to come back\n`,
    );
  });
});
