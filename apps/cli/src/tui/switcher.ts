import {
  addProfile,
  listModels,
  type ModelInfo,
  removeProfile,
  updateProfile,
} from "@crit/providers";
import type { Depth, ProviderProfile, ProvidersFile, ResolvedConfig } from "@crit/schema";
import { loadProviders, saveProviders } from "@crit/store";
import type { CliContext } from "../context.ts";

export type Choice = {
  provider: string;
  model: string | null;
  effort: string | null;
  depth: Depth;
};

/**
 * What the model/provider/effort/depth shortcuts change. It holds the current
 * choice and reports changes; the screens decide what a change means (the
 * next AI action, or the retry of a review).
 */
export type Switcher = {
  current(): Choice;
  /** Called after every change. Returns an unsubscribe function. */
  subscribe(fn: (choice: Choice) => void): () => void;
  providers(): Pick<ProviderProfile, "name" | "type" | "model" | "enabled">[];
  setProvider(name: string): Choice;
  models(): Promise<{ models: ModelInfo[]; live: boolean }>;
  /** Efforts the current model accepts. Empty when the CLI has none (Cursor). */
  efforts(): Promise<string[]>;
  setModel(id: string | null): Choice;
  setEffort(effort: string | null): Choice;
  setDepth(depth: Depth): Choice;
  /** Write provider, model and effort back to the saved profile. */
  save(): string;
  /** Provider types that can be added, with the environment variable that selects an account. */
  types(): { type: string; label: string; accountVar?: string }[];
  /** A free name for a new profile of this type. */
  suggestName(type: string): string;
  /** Add a profile, save it and switch to it. `account` is a config folder for another login. */
  add(input: { type: string; name: string; account?: string }): Choice;
  /** Remove a profile and save. The last one cannot be removed. */
  remove(name: string): void;
};

export function createSwitcher(
  ctx: CliContext,
  initialFile: ProvidersFile,
  config: Pick<ResolvedConfig, "depth">,
  initial: Partial<Choice> & { provider: string },
  onChange: (choice: Choice) => void = () => undefined,
): Switcher {
  let file = initialFile;
  const profile = (name: string) => file.providers.find((p) => p.name === name);
  const start = profile(initial.provider);
  let choice: Choice = {
    provider: initial.provider,
    model: initial.model !== undefined ? initial.model : (start?.model ?? null),
    effort: initial.effort !== undefined ? initial.effort : (start?.effort ?? null),
    depth: initial.depth ?? config.depth,
  };
  const listeners = new Set<(c: Choice) => void>([onChange]);
  const set = (patch: Partial<Choice>): Choice => {
    choice = { ...choice, ...patch };
    for (const l of listeners) l(choice);
    return choice;
  };
  const cache = new Map<string, Awaited<ReturnType<typeof listModels>>>();
  const modelsFor = async (name: string) => {
    const p = profile(name);
    const factory = p ? ctx.registry.get(p.type) : undefined;
    if (!p || !factory) return { models: [], live: false };
    const hit = cache.get(name);
    if (hit) return hit;
    const r = await listModels(factory, { command: p.command, env: ctx.env });
    cache.set(name, r);
    return r;
  };
  return {
    current: () => choice,
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    providers: () => file.providers.filter((p) => p.enabled),
    setProvider(name) {
      const p = profile(name);
      return set({ provider: name, model: p?.model ?? null, effort: p?.effort ?? null });
    },
    models: () => modelsFor(choice.provider),
    async efforts() {
      const p = profile(choice.provider);
      const factory = p ? ctx.registry.get(p.type) : undefined;
      if (!factory) return [];
      const { models } = await modelsFor(choice.provider);
      const info =
        models.find((m) => m.id === choice.model) ?? models.find((m) => m.efforts?.length);
      return info?.efforts?.length ? info.efforts : factory.efforts;
    },
    setModel: (model) => set({ model }),
    setEffort: (effort) => set({ effort }),
    setDepth: (depth) => set({ depth }),
    save() {
      // Re-read the file so edits made elsewhere are not overwritten.
      const fresh = loadProviders(ctx.paths) ?? file;
      saveProviders(
        ctx.paths,
        updateProfile(fresh, choice.provider, { model: choice.model, effort: choice.effort }),
      );
      return choice.provider;
    },
    types: () =>
      ctx.registry.list().map((f) => ({
        type: f.type,
        label: f.label,
        ...(ACCOUNT_VAR[f.type] ? { accountVar: ACCOUNT_VAR[f.type] } : {}),
      })),
    suggestName(type) {
      const base = ctx.registry.get(type)?.defaultName ?? type;
      let n = 2;
      let name = base;
      while (profile(name)) name = `${base}-${n++}`;
      return name;
    },
    add({ type, name, account }) {
      const factory = ctx.registry.get(type);
      if (!factory) throw new Error(`crit: unknown provider type ${type}`);
      const env = account && ACCOUNT_VAR[type] ? { [ACCOUNT_VAR[type]!]: account } : undefined;
      const fresh = loadProviders(ctx.paths) ?? file;
      file = addProfile(fresh, {
        name,
        type,
        command: factory.defaultCommand,
        model: null,
        ...(env ? { env } : {}),
      });
      saveProviders(ctx.paths, file);
      cache.delete(name);
      return set({ provider: name, model: null, effort: null });
    },
    remove(name) {
      const fresh = loadProviders(ctx.paths) ?? file;
      const rest = fresh.providers.filter((p) => p.name !== name);
      if (rest.length === 0) throw new Error("crit: keep at least one provider");
      file = removeProfile(fresh, name, rest.find((p) => p.enabled)?.name ?? rest[0]!.name);
      saveProviders(ctx.paths, file);
      if (choice.provider === name) {
        const next = file.providers.find((p) => p.enabled) ?? file.providers[0]!;
        set({ provider: next.name, model: next.model ?? null, effort: next.effort ?? null });
      }
    },
  };
}

/** The variable each agent CLI reads to pick its login. */
const ACCOUNT_VAR: Record<string, string> = {
  "claude-code": "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};

export const describeChoice = (c: Choice) =>
  `${c.provider} · ${c.model ?? "default model"} · effort ${c.effort ?? "default"} · ${c.depth}`;

/** The choice as status-bar items. */
export const describeChoiceParts = (c: Choice) => [
  { k: "provider", v: c.provider, tone: "lav" as const },
  { k: "model", v: c.model ?? "default", tone: "lav" as const },
  { k: "effort", v: c.effort ?? "default", tone: "orange" as const },
  { k: "depth", v: c.depth, tone: "orange" as const },
];
