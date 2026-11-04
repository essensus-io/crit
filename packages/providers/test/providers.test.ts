import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionHandler, startSessionHost } from "@crit/mcp";
import type { AgentEvent, AgentTask, FindingInput } from "@crit/schema";
import { critPaths, loadProviders, saveProviders } from "@crit/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AdapterRegistry,
  addProfile,
  commandVersion,
  compareVersions,
  createDefaultRegistry,
  detectCli,
  detectInstalled,
  emptyProvidersFile,
  FakeAdapter,
  fakeFactory,
  type FakeScriptInput,
  FakeScript,
  findingsInPrompt,
  ProfileError,
  removeProfile,
  resetFakes,
  resolveProvider,
  rolesOf,
  setDefault,
  setRole,
  streamProcess,
  updateProfile,
  which,
} from "../src/index.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crit-providers-"));
  resetFakes();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const posix = process.platform !== "win32";

function script(name: string, body: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const p = join(bin, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("AdapterRegistry", () => {
  it("registers, lists (hiding the fake) and creates adapters", () => {
    const reg = createDefaultRegistry();
    expect(reg.get("fake")).toBe(fakeFactory);
    expect(reg.list().map((f) => f.type)).not.toContain("fake");
    expect(reg.list({ includeHidden: true }).map((f) => f.type)).toContain("fake");
    const a = reg.create(
      { name: "f", type: "fake", command: join(dir, "none.json"), model: null, enabled: true },
      { env: {}, tmpDir: dir },
    );
    expect(a.type).toBe("fake");
    expect(() =>
      reg.create(
        { name: "o", type: "opencode", command: "opencode", model: null, enabled: true },
        { env: {}, tmpDir: dir },
      ),
    ).toThrow(/no adapter for provider type "opencode" \(known: claude-code, codex, fake\)/);
  });
});

describe("process helpers", () => {
  it.skipIf(!posix)("finds executables on PATH and by path", () => {
    const p = script("claude", "echo 'claude 2.1.3 (Claude Code)'");
    writeFileSync(join(dir, "bin", "notexec"), "x");
    expect(which("claude", { PATH: join(dir, "bin") })).toBe(p);
    expect(which(p, {})).toBe(p);
    expect(which("notexec", { PATH: join(dir, "bin") })).toBeUndefined();
    expect(which("nope", { PATH: join(dir, "bin") })).toBeUndefined();
    expect(which(join(dir, "nope"), {})).toBeUndefined();
    expect(which("bin", { PATH: dir })).toBeUndefined();
  });

  it.skipIf(!posix)("reads versions", async () => {
    const p = script("codex", "echo 'codex-cli 0.98.0'");
    expect(await commandVersion(p)).toBe("0.98.0");
    const bad = script("broken", "echo nothing; exit 3");
    expect(await commandVersion(bad)).toBeUndefined();
    expect(await commandVersion(join(dir, "missing"))).toBeUndefined();
  });

  it("streams stdout and stderr lines, stdin and the exit code", async () => {
    const events = await collect(
      streamProcess({
        command: process.execPath,
        args: [
          "-e",
          "process.stdin.on('data',d=>{process.stdout.write('got '+d+'\\nsecond');console.error('warn');process.exitCode=2})",
        ],
        cwd: dir,
        stdin: "hi",
      }),
    );
    expect(events.filter((e) => e.kind === "stdout")).toEqual([
      { kind: "stdout", line: "got hi" },
      { kind: "stdout", line: "second" },
    ]);
    expect(events).toContainEqual({ kind: "stderr", line: "warn" });
    expect(events.at(-1)).toEqual({ kind: "exit", code: 2, signal: null, timedOut: false });
  });

  it("kills on timeout and on abort", async () => {
    const slow = ["-e", "setTimeout(()=>{}, 10000)"];
    const t = await collect(
      streamProcess({ command: process.execPath, args: slow, cwd: dir, timeoutMs: 100 }),
    );
    expect(t.at(-1)).toMatchObject({ kind: "exit", timedOut: true });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const a = await collect(
      streamProcess({ command: process.execPath, args: slow, cwd: dir, signal: ac.signal }),
    );
    expect(a.at(-1)).toMatchObject({ kind: "exit", timedOut: false });
  });

  it("stops the child when the consumer breaks early", async () => {
    const gen = streamProcess({
      command: process.execPath,
      args: ["-e", "setInterval(()=>console.log('tick'),5)"],
      cwd: dir,
    });
    for await (const e of gen) {
      expect(e).toEqual({ kind: "stdout", line: "tick" });
      break;
    }
  });

  it("throws when the command does not exist", async () => {
    await expect(
      collect(streamProcess({ command: join(dir, "no-such-cli"), args: [], cwd: dir })),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("detection", () => {
  it.skipIf(!posix)("detects known CLIs on PATH with versions", async () => {
    script("claude", "echo '2.1.3 (Claude Code)'");
    const reg = new AdapterRegistry()
      .register({ ...fakeFactory, type: "claude-code", defaultCommand: "claude", hidden: false })
      .register({ ...fakeFactory, type: "cursor", defaultCommand: "cursor-agent", hidden: false });
    const found = await detectInstalled(reg, { PATH: join(dir, "bin") });
    expect(found.map((d) => [d.factory.type, d.version ?? null, Boolean(d.path)])).toEqual([
      ["claude-code", "2.1.3", true],
      ["cursor", null, false],
    ]);
  });

  it.skipIf(!posix)("flags versions outside the tested range", async () => {
    script("claude", "echo '9.0.0'");
    const env = { PATH: join(dir, "bin") };
    expect(await detectCli("claude", env, { min: "2.0.0", max: "3.0.0" })).toMatchObject({
      installed: true,
      version: "9.0.0",
      untestedVersion: true,
    });
    expect(await detectCli("claude", env, { min: "1.0.0" })).not.toHaveProperty("untestedVersion");
    expect(await detectCli("missing", env, { min: "1" })).toEqual({
      installed: false,
      loggedIn: false,
      hint: "missing not found on PATH",
    });
    script("noversion", "exit 1");
    expect(await detectCli("noversion", env, { min: "1" })).toMatchObject({
      installed: true,
      loggedIn: true,
    });
  });

  it("compares versions", () => {
    expect(compareVersions("2.1.10", "2.1.9")).toBe(1);
    expect(compareVersions("2.1", "2.1.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(0);
    expect(compareVersions("0.9", "1")).toBe(-1);
  });
});

describe("profiles", () => {
  const claude = { name: "claude", type: "claude-code", command: "claude", model: "opus" };
  const codex = { name: "codex", type: "codex", command: "codex" };

  it("adds profiles; the first becomes the default", () => {
    let f = addProfile(emptyProvidersFile(), claude);
    f = addProfile(f, codex);
    expect(f.default).toBe("claude");
    expect(f.providers[1]).toEqual({ ...codex, model: null, enabled: true });
    expect(addProfile(f, { ...codex, name: "c2" }, { makeDefault: true }).default).toBe("c2");
    expect(() => addProfile(f, claude)).toThrow(/already exists/);
  });

  it("updates and renames, carrying default and roles", () => {
    let f = addProfile(addProfile(emptyProvidersFile(), claude), codex);
    f = setRole(setRole(f, "skeptic", "codex"), "evaluate", "claude");
    f = updateProfile(f, "claude", { name: "cc", model: null });
    expect(f.default).toBe("cc");
    expect(f.roles).toEqual({ skeptic: "codex", evaluate: "cc" });
    expect(f.providers[0]).toMatchObject({ name: "cc", model: null });
    expect(updateProfile(f, "codex", { enabled: false }).providers[1]!.enabled).toBe(false);
    expect(() => updateProfile(f, "codex", { name: "cc" })).toThrow(/already exists/);
    expect(() => updateProfile(f, "ghost", {})).toThrow(
      /no provider named "ghost" \(have: cc, codex\)/,
    );
    expect(rolesOf(f, "cc")).toEqual(["evaluate"]);
  });

  it("removes profiles, asking for a new default when needed", () => {
    let f = setRole(
      addProfile(addProfile(emptyProvidersFile(), claude), codex),
      "skeptic",
      "codex",
    );
    expect(() => removeProfile(f, "claude")).toThrow(ProfileError);
    expect(() => removeProfile(f, "claude", "ghost")).toThrow(/no provider named "ghost"/);
    const r = removeProfile(f, "claude", "codex");
    expect(r.default).toBe("codex");
    const r2 = removeProfile(f, "codex");
    expect(r2.roles).toEqual({});
    expect(removeProfile(removeProfile(f, "codex"), "claude").default).toBeNull();
    expect(() => removeProfile(f, "ghost")).toThrow(/no provider/);
  });

  it("sets defaults and roles", () => {
    let f = addProfile(addProfile(emptyProvidersFile(), claude), { ...codex, enabled: false });
    expect(() => setDefault(f, "codex")).toThrow(/disabled/);
    f = updateProfile(f, "codex", { enabled: true });
    expect(setDefault(f, "codex").default).toBe("codex");
    expect(setRole(setRole(f, "skeptic", "codex"), "skeptic", null).roles).toEqual({});
    expect(() => setRole(f, "skeptic", "ghost")).toThrow(/no provider/);
  });

  it("resolves the provider for a run", () => {
    let f = addProfile(addProfile(emptyProvidersFile(), claude), codex);
    expect(resolveProvider(f).profile.name).toBe("claude");
    expect(resolveProvider(f, { name: "codex" }).profile.name).toBe("codex");
    expect(resolveProvider(setRole(f, "skeptic", "codex"), { role: "skeptic" }).profile.name).toBe(
      "codex",
    );
    expect(resolveProvider(f, { role: "skeptic" }).profile.name).toBe("claude");
    expect(resolveProvider(setRole(f, "review", "codex")).profile.name).toBe("codex");
    expect(resolveProvider(f, { preferred: "codex" }).profile.name).toBe("codex");
    const missing = resolveProvider(f, { preferred: "team-claude" });
    expect(missing.profile.name).toBe("claude");
    expect(missing.warnings[0]).toMatch(/prefers provider "team-claude"/);

    f = updateProfile(f, "claude", { enabled: false });
    expect(() => resolveProvider(f, { name: "claude" })).toThrow(/disabled/);
    const fallback = resolveProvider(f);
    expect(fallback.profile.name).toBe("codex");
    expect(fallback.warnings).toEqual([
      "provider claude (default) is disabled; skipping it",
      "no usable default provider; using codex",
    ]);
    expect(
      resolveProvider(setRole(f, "skeptic", "claude"), { role: "skeptic" }).warnings[0],
    ).toMatch(/role skeptic/);
    expect(() => resolveProvider(updateProfile(f, "codex", { enabled: false }))).toThrow(
      /no enabled providers/,
    );
  });

  it("round-trips through providers.json", () => {
    const paths = critPaths({ CRIT_HOME: dir });
    let f = addProfile(addProfile(emptyProvidersFile(), claude), codex);
    f = setRole(f, "skeptic", "codex");
    saveProviders(paths, f);
    expect(loadProviders(paths)).toEqual({
      $schema: expect.stringMatching(/providers\.json$/),
      ...f,
    });
  });
});

describe("fake provider", () => {
  const finding = {
    file: "src/a.ts",
    range: { start: 1, end: 1 },
    anchor: "const a = 1;",
    severity: "minor",
    category: "style",
    title: "Prefer let",
    explanation: "x",
    confidence: 0.5,
  };
  const task = (over: Partial<AgentTask> = {}): AgentTask => ({
    kind: "review",
    cwd: dir,
    systemPrompt: "",
    prompt: "Review src/a.ts",
    timeoutMs: 10_000,
    ...over,
  });

  it("replays events and scripted MCP calls through the real server", async () => {
    const reported: FindingInput[] = [];
    const handler: SessionHandler = {
      getScope: async () => ({ label: "x", files: [], notes: "" }),
      getRules: async () => [],
      reportFinding: async (f) => {
        reported.push(f);
        return { accepted: true, id: "f1" };
      },
      finish: async () => ({ ok: true }),
    };
    const sessions = join(dir, "sessions");
    const host = await startSessionHost({ handler, dir: sessions });
    const fake = new FakeAdapter(
      FakeScript.parse({
        runs: [
          {
            match: { kind: "review", promptIncludes: "src/a.ts" },
            events: [{ type: "progress", text: "reading a.ts" }],
            calls: [
              { tool: "report_finding", args: finding },
              { tool: "finish", args: { summary: "one" } },
            ],
          },
        ],
      } satisfies FakeScriptInput),
      { model: null },
    );
    try {
      const events = await collect(
        fake.run(
          task({
            mcpSession: host.sessionId,
            mcp: { command: "crit", args: [], sessionsDir: sessions },
          }),
          new AbortController().signal,
        ),
      );
      expect(events.map((e) => e.type)).toEqual([
        "progress",
        "tool",
        "progress",
        "tool",
        "progress",
        "usage",
        "done",
      ]);
      expect(events[2]).toEqual({ type: "progress", text: "report_finding: Recorded finding f1." });
      expect(reported).toHaveLength(1);
      expect(fake.calls[0]!.run).toBeDefined();
      // consumed: a second run has no script left
      const again = await collect(fake.run(task(), new AbortController().signal));
      expect(again).toEqual([
        { type: "error", message: "fake provider: no scripted run for review" },
        { type: "done", exitCode: 1 },
      ]);
    } finally {
      await host.close();
    }
  });

  it("answers skeptic prompts per finding and supports repeat, match and messages", async () => {
    const fake = new FakeAdapter(
      FakeScript.parse({
        runs: [
          {
            match: { kind: "skeptic" },
            skeptic: { default: "confirmed", byTitle: { Unused: "rejected" } },
            repeat: true,
          },
          { match: { kind: "answer" }, message: "Yes, it can be null.", exitCode: 0 },
        ],
      }),
      { model: "fake-small" },
    );
    const prompt = `Check these.\n<findings>\n${JSON.stringify([
      { id: "a", title: "Unused import" },
      { id: "b", title: "N+1 query" },
    ])}\n</findings>`;
    for (let i = 0; i < 2; i++) {
      const events = await collect(
        fake.run(task({ kind: "skeptic", prompt }), new AbortController().signal),
      );
      const msg = events.find(
        (e): e is Extract<AgentEvent, { type: "message" }> => e.type === "message",
      )!;
      expect(JSON.parse(msg.text).results).toEqual([
        { findingId: "a", verdict: "rejected", reason: "fake skeptic: rejected" },
        { findingId: "b", verdict: "confirmed", reason: "fake skeptic: confirmed" },
      ]);
    }
    const answer = await collect(fake.run(task({ kind: "answer" }), new AbortController().signal));
    expect(answer).toContainEqual({ type: "message", text: "Yes, it can be null." });
    expect(fake.profile.model).toBe("fake-small");
  });

  it("fails clearly when calls need MCP but the task has none", async () => {
    const fake = new FakeAdapter(
      FakeScript.parse({ runs: [{ calls: [{ tool: "finish", args: { summary: "x" } }] }] }),
      { model: null },
    );
    await expect(collect(fake.run(task(), new AbortController().signal))).rejects.toThrow(
      /no MCP session/,
    );
  });

  it("honours delays and aborts", async () => {
    const fake = new FakeAdapter(
      FakeScript.parse({ runs: [{ delayMs: 5000 }, { message: "x" }] }),
      { model: null },
    );
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    await expect(collect(fake.run(task(), ac.signal))).rejects.toThrow("aborted");
    const done = new AbortController();
    const it = fake.run(task(), done.signal)[Symbol.asyncIterator]();
    done.abort();
    const events: AgentEvent[] = [];
    for (let r = await it.next(); !r.done; r = await it.next()) events.push(r.value);
    expect(events.at(-1)).toEqual({ type: "done", exitCode: 130 });
    const pre = new AbortController();
    pre.abort();
    const f2 = new FakeAdapter(FakeScript.parse({ runs: [{ delayMs: 5 }] }), { model: null });
    await expect(collect(f2.run(task(), pre.signal))).rejects.toThrow("aborted");
  });

  it("loads scripts from the profile command or CRIT_FAKE_SCRIPT and caches instances", async () => {
    const path = join(dir, "script.json");
    writeFileSync(path, JSON.stringify({ version: "1.2.3", runs: [] }));
    const profile = { name: "f", type: "fake", command: path, model: null, enabled: true };
    const a = fakeFactory.create(profile, { env: {}, tmpDir: dir });
    expect(fakeFactory.create(profile, { env: {}, tmpDir: dir })).toBe(a);
    expect(await a.detect()).toEqual({
      installed: true,
      version: "1.2.3",
      loggedIn: true,
      path: "fake",
    });
    const missing = fakeFactory.create(
      { ...profile, command: "x" },
      { env: { CRIT_FAKE_SCRIPT: join(dir, "nope.json") }, tmpDir: dir },
    );
    expect((await missing.detect()).loggedIn).toBe(false);
  });

  it("extracts findings from skeptic prompts", () => {
    expect(findingsInPrompt("no block")).toEqual([]);
    expect(findingsInPrompt("<findings>not json</findings>")).toEqual([]);
  });
});
