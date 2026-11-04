import { homedir } from "node:os";
import { join } from "node:path";
import { type AdapterRegistry, createDefaultRegistry } from "@crit/providers";
import { critPaths, type CritPaths, dbPath, openStore, type SqliteStore } from "@crit/store";
import { ClackPrompter, type Prompter } from "./prompter.ts";

/**
 * Everything a command touches from the outside world. The real entry builds
 * it from the process; tests pass their own (temp homes, scripted prompts,
 * captured output, a registry with the fake provider).
 */
export type CliContext = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  home: string;
  paths: CritPaths;
  /** stdout is a terminal (and the user can be prompted). */
  interactive: boolean;
  color: boolean;
  out: (text: string) => void;
  err: (text: string) => void;
  prompter: Prompter;
  registry: AdapterRegistry;
  /** How agents start `crit mcp`; `--session <id>` is appended. */
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
    // Agents may start MCP servers with a reduced environment (Codex drops
    // CRIT_HOME), so the sessions folder is passed explicitly.
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
