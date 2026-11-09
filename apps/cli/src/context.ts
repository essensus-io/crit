import { homedir } from "node:os";
import { join } from "node:path";
import { type AdapterRegistry, createDefaultRegistry } from "@crit/providers";
import { critPaths, type CritPaths, dbPath, openStore, type SqliteStore } from "@crit/store";
import { ClackPrompter, type Prompter } from "./shared/lib/index.ts";

export type CliContext = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  home: string;
  paths: CritPaths;
  interactive: boolean;
  color: boolean;
  out: (text: string) => void;
  err: (text: string) => void;
  prompter: Prompter;
  registry: AdapterRegistry;
  mcpCommand: { command: string; args: string[] };
  version: string;
  openStore(): SqliteStore;
  now(): number;
};

export function processContext(version: string): CliContext {
  const env = process.env;
  const paths = critPaths(env);
  const interactive =
    Boolean(process.stdout.isTTY && process.stdin.isTTY) &&
    env.CI !== "true" &&
    env.CRIT_NO_TTY !== "1";
  let store: SqliteStore | undefined;
  return {
    cwd: process.cwd(),
    env,
    home: env.CRIT_FAKE_HOME ?? homedir(),
    paths,
    interactive,
    color: Boolean(process.stdout.isTTY) && env.NO_COLOR === undefined && env.FORCE_COLOR !== "0",
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    prompter: new ClackPrompter(),
    registry: createDefaultRegistry(),
    mcpCommand: {
      command: process.execPath,
      args: [process.argv[1]!, "mcp", "--sessions-dir", join(paths.cache, "sessions")],
    },
    version,
    openStore: () => (store ??= openStore(dbPath(paths))),
    now: Date.now,
  };
}

export const sessionsDir = (ctx: CliContext) => join(ctx.paths.cache, "sessions");
