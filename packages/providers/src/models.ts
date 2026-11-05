import { x } from "tinyexec";
import type { AdapterFactory } from "./adapter.ts";

export type ModelInfo = {
  /** What goes after --model. */
  id: string;
  label: string;
  /** Reasoning efforts this model accepts, when the CLI reports them. */
  efforts?: string[];
  defaultEffort?: string;
  /** Short note shown next to the label: "default", "hidden", … */
  hint?: string;
};

const ZERO_WIDTH = /[​-‍⁠﻿]/g;

/**
 * `codex debug models` prints the catalog the CLI itself uses. Only models the
 * CLI lists to users (visibility "list") are offered, in its own priority order.
 */
export function parseCodexModels(json: string): ModelInfo[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const raw = Array.isArray(data) ? data : ((data as { models?: unknown }).models ?? []);
  if (!Array.isArray(raw)) return [];
  type Raw = {
    slug?: string;
    display_name?: string;
    visibility?: string;
    priority?: number;
    default_reasoning_level?: string;
    supported_reasoning_levels?: { effort?: string }[];
  };
  return (raw as Raw[])
    .filter((m) => m.slug && m.visibility === "list")
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((m) => {
      const efforts = (m.supported_reasoning_levels ?? [])
        .map((l) => l.effort)
        .filter((e): e is string => Boolean(e));
      return {
        id: m.slug!,
        label: m.display_name ?? m.slug!,
        ...(efforts.length ? { efforts } : {}),
        ...(m.default_reasoning_level ? { defaultEffort: m.default_reasoning_level } : {}),
      };
    });
}

/**
 * `cursor-agent --list-models`: lines of "<id> - <label>" under a header, then a
 * tip. The effort and speed are part of the id (gpt-5.3-codex-high-fast), so
 * there is no separate effort to choose.
 */
export function parseCursorModels(text: string): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const line of text.replace(ZERO_WIDTH, "").split("\n")) {
    const m = /^([A-Za-z0-9][\w.\-[\]=,]*) - (.+?)\s*$/.exec(line.trim());
    if (!m) continue;
    const hint = /\(([^)]*default[^)]*)\)/i.exec(m[2]!)?.[1];
    out.push({ id: m[1]!, label: m[2]!.trim(), ...(hint ? { hint } : {}) });
  }
  return out;
}

async function capture(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string | undefined> {
  try {
    const r = await x(command, args, {
      nodeOptions: { env, stdio: ["ignore", "pipe", "pipe"] },
      timeout: timeoutMs,
      throwOnError: false,
    });
    return r.exitCode === 0 ? r.stdout : undefined;
  } catch {
    return undefined;
  }
}

export const codexModels = (command: string, env: NodeJS.ProcessEnv, timeoutMs = 8000) =>
  capture(command, ["debug", "models"], env, timeoutMs).then((out) =>
    out ? parseCodexModels(out) : [],
  );

export const cursorModels = (command: string, env: NodeJS.ProcessEnv, timeoutMs = 8000) =>
  capture(command, ["--list-models"], env, timeoutMs).then((out) =>
    out ? parseCursorModels(out) : [],
  );

/** Models to offer for a provider: the CLI's own list, falling back to the factory's static one. */
export async function listModels(
  factory: Pick<AdapterFactory, "models" | "listModels">,
  opts: { command: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ models: ModelInfo[]; live: boolean }> {
  if (factory.listModels) {
    const live = await factory.listModels({
      command: opts.command,
      env: opts.env,
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
    if (live.length) return { models: live, live: true };
  }
  return { models: factory.models.map((id) => ({ id, label: id })), live: false };
}
