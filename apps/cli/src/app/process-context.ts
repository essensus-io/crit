import { homedir } from "node:os";
import { join } from "node:path";
import { createDefaultRegistry } from "@crit/providers";
import { critPaths, dbPath, openStore, type SqliteStore } from "@crit/store";
import { createClackPrompter } from "@/shared/lib/prompter.ts";
import { type CliContext } from "@/shared/lib/cli-context.ts";

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
    prompter: createClackPrompter(),
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
