import type { DetectResult } from "@crit/schema";
import type { AdapterFactory, AdapterRegistry } from "./adapter.ts";
import { commandVersion, which } from "./process.ts";

export type Detected = { factory: AdapterFactory; path?: string; version?: string };

export async function detectInstalled(
  registry: AdapterRegistry,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Detected[]> {
  return Promise.all(
    registry.list().map(async (factory) => {
      const path = which(factory.defaultCommand, env);
      if (!path) return { factory };
      const version = await commandVersion(path, env);
      return { factory, path, ...(version ? { version } : {}) };
    }),
  );
}

export async function detectCli(
  command: string,
  env: NodeJS.ProcessEnv,
  tested: { min: string; max?: string },
): Promise<DetectResult> {
  const path = which(command, env);
  if (!path) return { installed: false, loggedIn: false, hint: `${command} not found on PATH` };
  const version = await commandVersion(path, env);
  const r: DetectResult = { installed: true, path, loggedIn: true };
  if (version) {
    r.version = version;
    if (
      compareVersions(version, tested.min) < 0 ||
      (tested.max && compareVersions(version, tested.max) > 0)
    ) {
      r.untestedVersion = true;
    }
  }
  return r;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0]!.split(".").map(Number);
  const pb = b.split(/[-+]/)[0]!.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}
