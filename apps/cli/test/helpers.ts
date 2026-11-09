import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdapterRegistry,
  FakeAdapter,
  FakeScript,
  type FakeScriptInput,
  fakeFactory,
  type ModelInfo,
} from "@crit/providers";
import { critPaths, dbPath, openStore, type SqliteStore } from "@crit/store";
import type { CliContext } from "../src/context.ts";
import { runCli, VERSION } from "../src/app/main.ts";
import { ScriptedPrompter } from "../src/shared/lib/prompter.ts";

export type TestEnv = {
  ctx: CliContext;
  dir: string;
  prompter: ScriptedPrompter;
  stdout(): string;
  stderr(): string;
  run(...argv: string[]): Promise<number>;
  script(s: FakeScriptInput): void;
  fakes: FakeAdapter[];
  cleanup(): void;
};

export function testContext(
  opts: {
    interactive?: boolean;
    answers?: ConstructorParameters<typeof ScriptedPrompter>[0];
    cwd?: string;
    models?: ModelInfo[];
  } = {},
): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "crit-cli-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  if (process.platform !== "win32") {
    writeFileSync(join(bin, "test-agent"), "#!/bin/sh\necho 'test-agent 1.2.3'\n");
    chmodSync(join(bin, "test-agent"), 0o755);
  }
  const env: NodeJS.ProcessEnv = { PATH: bin, CRIT_HOME: join(dir, "crit") };
  let out = "";
  let err = "";
  const prompter = new ScriptedPrompter(opts.answers ?? []);
  let script: FakeScript = FakeScript.parse({ runs: [] });
  const fakes: FakeAdapter[] = [];
  const registry = new AdapterRegistry().register({
    ...fakeFactory,
    type: "test-agent",
    label: "Test Agent",
    defaultCommand: "test-agent",
    defaultName: "agent",
    loginHint: "run `test-agent login`",
    hidden: false,
    ...(opts.models ? { listModels: async () => opts.models! } : {}),
    create: (profile) => {
      const f = new FakeAdapter(script, profile);
      fakes.push(f);
      return {
        type: "test-agent",
        capabilities: f.capabilities,
        detect: async () => {
          const d = await f.detect();
          return { ...d, installed: profile.command !== "missing-agent" };
        },
        run: (t, s) => f.run(t, s),
      };
    },
  });
  const paths = critPaths(env);
  let store: SqliteStore | undefined;
  const ctx: CliContext = {
    cwd: opts.cwd ?? dir,
    env,
    home: join(dir, "home"),
    paths,
    interactive: opts.interactive ?? false,
    color: false,
    out: (t) => void (out += t),
    err: (t) => void (err += t),
    prompter,
    registry,
    mcpCommand: { command: "crit", args: ["mcp"] },
    version: VERSION,
    openStore: () => (store ??= openStore(dbPath(paths))),
    now: Date.now,
  };
  return {
    ctx,
    dir,
    prompter,
    stdout: () => out,
    stderr: () => err,
    run: (...argv) => runCli(argv, ctx),
    script: (s) => {
      script = FakeScript.parse(s);
    },
    fakes,
    cleanup: () => {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function normalize(s: string, env: TestEnv, extra: Record<string, string> = {}): string {
  let r = s;
  for (const [from, to] of Object.entries(extra)) r = r.split(from).join(to);
  return r
    .split(env.dir)
    .join("<tmp>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<id>")
    .replace(/review [0-9a-f]{4}\b/g, "review <short>")
    .replace(/crit (open|apply) [0-9a-f]{4}\b/g, "crit $1 <short>")
    .replace(/\b\d+(\.\d+)?(ms|s)\b|\b\d+m\d{2}s\b/g, "<dur>")
    .replace(/~\d+(\.\d+)?[kM]? tokens/g, "~<tok> tokens")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<time>")
    .replace(/`[0-9a-f]{12}`/g, "`<sha>`");
}

export const fakeProvidersJson = (env: TestEnv, extra: object = {}) => {
  const p = join(env.ctx.paths.config, "providers.json");
  mkdirSync(env.ctx.paths.config, { recursive: true });
  writeFileSync(
    p,
    JSON.stringify({
      default: "agent",
      providers: [
        { name: "agent", type: "test-agent", command: "test-agent", model: null, enabled: true },
      ],
      roles: {},
      ...extra,
    }),
  );
  return p;
};
