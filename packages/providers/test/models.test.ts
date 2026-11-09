import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTask } from "@crit/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildClaudeInvocation,
  buildCodexInvocation,
  claudeCodeFactory,
  claudeModels,
  codexFactory,
  cursorFactory,
  listModels,
  parseCodexModels,
  parseCursorModels,
} from "../src/index.ts";

const FIX = join(import.meta.dirname, "fixtures", "models");

describe("parseCodexModels (recorded `codex debug models`)", () => {
  const models = parseCodexModels(readFileSync(join(FIX, "codex-debug-models.json"), "utf8"));

  it("offers only the models the CLI lists, in its priority order, with their efforts", () => {
    expect(models.length).toBeGreaterThanOrEqual(6);
    expect(models.every((m) => m.id && m.label)).toBe(true);
    expect(models.map((m) => m.id)).not.toContain("gpt-reserve");
    const sol = models.find((m) => m.id === "gpt-6.1-sol")!;
    expect(sol).toMatchObject({ label: "GPT-6.1-Sol", defaultEffort: "low" });
    expect(sol.efforts).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  it("tolerates garbage, bare arrays and missing fields", () => {
    expect(parseCodexModels("not json")).toEqual([]);
    expect(parseCodexModels("{}")).toEqual([]);
    expect(parseCodexModels(JSON.stringify({ models: "x" }))).toEqual([]);
    expect(
      parseCodexModels(
        JSON.stringify([
          { slug: "a", visibility: "list" },
          { slug: "b", visibility: "hide" },
          { visibility: "list" },
        ]),
      ),
    ).toEqual([{ id: "a", label: "a" }]);
  });
});

describe("parseCursorModels (recorded `cursor-agent --list-models`)", () => {
  const models = parseCursorModels(readFileSync(join(FIX, "cursor-list-models.txt"), "utf8"));

  it("reads every 'id - label' line and skips the header and the tip", () => {
    expect(models.length).toBeGreaterThan(100);
    expect(models[0]).toEqual({
      id: "auto",
      label: "Auto (current, default)",
      hint: "current, default",
    });
    const codex = models.find((m) => m.id === "gpt-5.3-codex-high-fast");
    expect(codex).toEqual({ id: "gpt-5.3-codex-high-fast", label: "Codex 5.3 High Fast" });
    expect(models.some((m) => /^(Available|Tip)/.test(m.id))).toBe(false);
    expect(new Set(models.map((m) => m.id)).size).toBe(models.length);
  });

  it("drops zero-width characters Cursor puts in some labels", () => {
    const m = parseCursorModels("grok-4.7-low-fast - Grok 4.7  Low Fast​​\nbad line\n");
    expect(m).toEqual([{ id: "grok-4.7-low-fast", label: "Grok 4.7  Low Fast" }]);
  });
});

describe("listModels", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "crit-models-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.skipIf(process.platform === "win32")(
    "runs the CLI's own listing, and falls back when it fails or is empty",
    async () => {
      const bin = join(dir, "codex");
      writeFileSync(
        bin,
        `#!/bin/sh\ncat ${JSON.stringify(join(FIX, "codex-debug-models.json"))}\n`,
      );
      chmodSync(bin, 0o755);
      const live = await listModels(codexFactory, { command: bin, env: process.env });
      expect(live.live).toBe(true);
      expect(live.models[0]!.id).toBe("gpt-6.1-sol");

      const broken = join(dir, "broken");
      writeFileSync(broken, "#!/bin/sh\nexit 3\n");
      chmodSync(broken, 0o755);
      expect(await listModels(codexFactory, { command: broken, env: process.env })).toEqual({
        models: [],
        live: false,
      });
      expect(await listModels(cursorFactory, { command: join(dir, "missing"), env: {} })).toEqual({
        models: [],
        live: false,
      });
      const claude = await listModels(claudeCodeFactory, { command: "claude", env: {} });
      expect(claude.live).toBe(false);
      expect(claude.models.slice(0, 3).map((m) => m.id)).toEqual(["opus", "sonnet", "haiku"]);
    },
  );
});

describe("effort reaches the CLIs", () => {
  const task = (over: Partial<AgentTask> = {}): AgentTask => ({
    kind: "review",
    cwd: "/repo",
    systemPrompt: "s",
    prompt: "p",
    timeoutMs: 1,
    ...over,
  });

  it("Claude Code gets --effort from the task, else the profile", () => {
    const flag = (inv: { args: string[] }) => inv.args[inv.args.indexOf("--effort") + 1];
    expect(
      flag(buildClaudeInvocation({ command: "claude", model: null, effort: "high" }, task(), "/t")),
    ).toBe("high");
    expect(
      flag(
        buildClaudeInvocation(
          { command: "claude", model: null, effort: "high" },
          task({ effort: "low" }),
          "/t",
        ),
      ),
    ).toBe("low");
    expect(
      buildClaudeInvocation({ command: "claude", model: null }, task(), "/t").args,
    ).not.toContain("--effort");
  });

  it("Codex gets model_reasoning_effort as a quoted TOML string", () => {
    const inv = buildCodexInvocation(
      { command: "codex", model: null, effort: "xhigh" },
      task(),
      "/t",
    );
    expect(inv.args).toContain('model_reasoning_effort="xhigh"');
    expect(
      buildCodexInvocation({ command: "codex", model: null }, task({ effort: "low" }), "/t").args,
    ).toContain('model_reasoning_effort="low"');
    expect(
      buildCodexInvocation({ command: "codex", model: null }, task(), "/t").args.join(" "),
    ).not.toContain("model_reasoning_effort");
  });
});

describe("claudeModels", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("without an API key the built-in list is used", async () => {
    expect(await claudeModels({})).toEqual([]);
    const r = await listModels(claudeCodeFactory, { command: "claude", env: {} });
    expect(r.live).toBe(false);
    expect(r.models.map((m) => m.id)).toEqual(expect.arrayContaining(["opus", "sonnet", "haiku"]));
  });

  it("with an API key it lists the real models, behind the family aliases", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
            { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" },
          ],
        }),
      ),
    );
    const r = await listModels(claudeCodeFactory, {
      command: "claude",
      env: { ANTHROPIC_API_KEY: "k" },
    });
    expect(r.live).toBe(true);
    expect(r.models.map((m) => m.id)).toEqual([
      "opus",
      "sonnet",
      "haiku",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
    ]);
    expect(r.models[3]).toMatchObject({ label: "Claude Opus 5.5" });
  });

  it("a failing request falls back to the built-in list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    const r = await listModels(claudeCodeFactory, {
      command: "claude",
      env: { ANTHROPIC_API_KEY: "bad" },
    });
    expect(r.live).toBe(false);
  });
});
