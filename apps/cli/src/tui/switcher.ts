import { listModels, type ModelInfo, updateProfile } from "@crit/providers";
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
};

export function createSwitcher(
  ctx: CliContext,
  file: ProvidersFile,
  config: Pick<ResolvedConfig, "depth">,
  initial: Partial<Choice> & { provider: string },
  onChange: (choice: Choice) => void = () => undefined,
): Switcher {
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
  };
}

export const describeChoice = (c: Choice) =>
  `${c.provider} · ${c.model ?? "default model"} · effort ${c.effort ?? "default"} · ${c.depth}`;

/** The choice as status-bar items. */
export const describeChoiceParts = (c: Choice) => [
  { k: "provider", v: c.provider, tone: "lav" as const },
  { k: "model", v: c.model ?? "default", tone: "lav" as const },
  { k: "effort", v: c.effort ?? "default", tone: "orange" as const },
  { k: "depth", v: c.depth, tone: "orange" as const },
];
