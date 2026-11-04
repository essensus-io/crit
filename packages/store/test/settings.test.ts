import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  critPaths,
  type CritPaths,
  dbPath,
  loadProjectConfig,
  loadProviders,
  loadUserConfig,
  providersPath,
  saveProjectConfig,
  saveProviders,
  SettingsError,
  userConfigPath,
} from "../src/index.ts";

let dir: string;
let paths: CritPaths;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crit-settings-"));
  paths = critPaths({ CRIT_HOME: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("critPaths", () => {
  it("puts everything under CRIT_HOME", () => {
    expect(paths).toEqual({
      config: join(dir, "config"),
      data: join(dir, "data"),
      cache: join(dir, "cache"),
    });
    expect(dbPath(paths)).toBe(join(dir, "data", "crit.db"));
  });

  it("lets each folder be overridden", () => {
    const p = critPaths({
      CRIT_HOME: dir,
      CRIT_CONFIG_DIR: "/c",
      CRIT_DATA_DIR: "/d",
      CRIT_CACHE_DIR: "/k",
    });
    expect(p).toEqual({ config: "/c", data: "/d", cache: "/k" });
  });

  it("uses standard app folders by default", () => {
    const p = critPaths({});
    for (const v of Object.values(p)) expect(v).toMatch(/crit/);
  });
});

describe("providers.json", () => {
  it("is undefined before first run, then round-trips with a $schema", () => {
    expect(loadProviders(paths)).toBeUndefined();
    saveProviders(paths, {
      default: "claude",
      providers: [
        { name: "claude", type: "claude-code", command: "claude", model: "opus", enabled: true },
      ],
      roles: { skeptic: "claude" },
    });
    const raw = JSON.parse(readFileSync(providersPath(paths), "utf8"));
    expect(raw.$schema).toMatch(/providers\.json$/);
    const loaded = loadProviders(paths);
    expect(loaded?.default).toBe("claude");
    expect(loaded?.roles).toEqual({ skeptic: "claude" });
  });

  it("refuses to save an invalid file", () => {
    expect(() => saveProviders(paths, { default: "ghost", providers: [], roles: {} })).toThrow(
      /ghost/,
    );
  });

  it("reports invalid JSON and schema errors with the file path", () => {
    mkdirSync(paths.config, { recursive: true });
    writeFileSync(providersPath(paths), "{ nope");
    expect(() => loadProviders(paths)).toThrow(SettingsError);
    expect(() => loadProviders(paths)).toThrow(/providers\.json: invalid JSON/);
    writeFileSync(providersPath(paths), JSON.stringify({ providers: [{ name: "x" }] }));
    expect(() => loadProviders(paths)).toThrow(/providers\.0\.type/);
    writeFileSync(providersPath(paths), JSON.stringify([]));
    expect(() => loadProviders(paths)).toThrow(/\(root\)/);
  });
});

describe("config files", () => {
  it("loads user and project config", () => {
    expect(loadUserConfig(paths)).toBeUndefined();
    mkdirSync(paths.config, { recursive: true });
    writeFileSync(userConfigPath(paths), JSON.stringify({ concurrency: 2 }));
    expect(loadUserConfig(paths)).toEqual({ concurrency: 2 });

    const root = join(dir, "repo");
    expect(loadProjectConfig(root)).toBeUndefined();
    saveProjectConfig(root, { provider: "claude", lenses: ["security"] });
    expect(loadProjectConfig(root)).toEqual({ provider: "claude", lenses: ["security"] });
  });
});
