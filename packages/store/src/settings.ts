import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ConfigFile, ProvidersFile } from "@crit/schema";
import envPaths from "env-paths";
import type { z } from "zod";

export type CritPaths = {
  /** Personal settings: providers.json, config.json, rules/ */
  config: string;
  /** crit.db */
  data: string;
  /** Agent transcripts, temp MCP configs */
  cache: string;
};

/**
 * Standard per-OS app folders (Linux: ~/.config/crit, ~/.local/share/crit, ~/.cache/crit).
 * `CRIT_HOME` puts all three under one folder (tests, portable installs);
 * `CRIT_CONFIG_DIR`, `CRIT_DATA_DIR`, `CRIT_CACHE_DIR` override each one.
 */
export function critPaths(env: NodeJS.ProcessEnv = process.env): CritPaths {
  const base = env.CRIT_HOME
    ? {
        config: join(env.CRIT_HOME, "config"),
        data: join(env.CRIT_HOME, "data"),
        cache: join(env.CRIT_HOME, "cache"),
      }
    : (() => {
        const p = envPaths("crit", { suffix: "" });
        return { config: p.config, data: p.data, cache: p.cache };
      })();
  return {
    config: env.CRIT_CONFIG_DIR ?? base.config,
    data: env.CRIT_DATA_DIR ?? base.data,
    cache: env.CRIT_CACHE_DIR ?? base.cache,
  };
}

export const dbPath = (paths: CritPaths) => join(paths.data, "crit.db");
export const providersPath = (paths: CritPaths) => join(paths.config, "providers.json");
export const userConfigPath = (paths: CritPaths) => join(paths.config, "config.json");
export const projectConfigPath = (root: string) => join(root, ".crit", "config.json");

export class SettingsError extends Error {
  readonly file: string;
  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.file = file;
    this.name = "SettingsError";
  }
}

function readJson<S extends z.ZodType>(file: string, schema: S): z.infer<S> | undefined {
  if (!existsSync(file)) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new SettingsError(file, `invalid JSON (${(err as Error).message})`);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new SettingsError(file, issues.join("; "));
  }
  return parsed.data;
}

/** Write JSON atomically (temp file + rename) so a crash never leaves half a file. */
export function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

/** `undefined` when providers.json does not exist yet (first run). */
export function loadProviders(paths: CritPaths): ProvidersFile | undefined {
  return readJson(providersPath(paths), ProvidersFile);
}

export function saveProviders(paths: CritPaths, file: ProvidersFile): void {
  const valid = ProvidersFile.parse(file);
  const { $schema: _ignored, ...rest } = valid;
  writeJsonAtomic(providersPath(paths), {
    $schema: "https://unpkg.com/crit/schema/providers.json",
    ...rest,
  });
}

export function loadUserConfig(paths: CritPaths): ConfigFile | undefined {
  return readJson(userConfigPath(paths), ConfigFile);
}

export function loadProjectConfig(root: string): ConfigFile | undefined {
  return readJson(projectConfigPath(root), ConfigFile);
}

export function saveProjectConfig(root: string, config: ConfigFile): void {
  writeJsonAtomic(projectConfigPath(root), ConfigFile.parse(config));
}
