import { join } from "node:path";
import { type GhRunner } from "@crit/core";
import { type AdapterRegistry } from "@crit/providers";
import { type CritPaths, type SqliteStore } from "@crit/store";
import { type Prompter } from "./prompter.ts";

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
  gh: GhRunner;
  loginToGithub: () => Promise<number>;
  mcpCommand: { command: string; args: string[] };
  version: string;
  openStore(): SqliteStore;
  now(): number;
};

export const sessionsDir = (ctx: CliContext) => join(ctx.paths.cache, "sessions");
