import {
  addProfile,
  listModels,
  type ModelInfo,
  removeProfile,
  updateProfile,
} from "@crit/providers";
import type { Depth, ProviderProfile, ProvidersFile, ResolvedConfig } from "@crit/schema";
import { loadProviders, saveProviders } from "@crit/store";
import type { CliContext } from "@/shared/lib/cli-context.ts";

export type Choice = {
  provider: string;
  model: string | null;
  effort: string | null;
  depth: Depth;
};

export type Switcher = {
  current(): Choice;
  subscribe(fn: (choice: Choice) => void): () => void;
  providers(): Pick<ProviderProfile, "name" | "type" | "model" | "enabled">[];
  setProvider(name: string): Choice;
  models(): Promise<{ models: ModelInfo[]; live: boolean }>;
  efforts(): Promise<string[]>;
  setModel(id: string | null): Choice;
  setEffort(effort: string | null): Choice;
  setDepth(depth: Depth): Choice;
  save(): string;
  types(): { type: string; label: string; accountVar?: string }[];
  suggestName(type: string): string;
  add(input: { type: string; name: string; account?: string }): Choice;
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
  const profile = (name: string) => file.providers.find((provider) => provider.name === name);
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
    for (const listener of listeners) listener(choice);
    return choice;
  };
  const cache = new Map<string, Awaited<ReturnType<typeof listModels>>>();
  const modelsFor = async (name: string) => {
    const p = profile(name);
    const factory = p ? ctx.registry.get(p.type) : undefined;
    if (!p || !factory) return { models: [], live: false };
    const hit = cache.get(name);
    if (hit) return hit;
    const result = await listModels(factory, { command: p.command, env: ctx.env });
    cache.set(name, result);
    return result;
  };
  return {
    current: () => choice,
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    providers: () => file.providers.filter((provider) => provider.enabled),
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
        models.find((modelInfo) => modelInfo.id === choice.model) ??
        models.find((modelInfo) => modelInfo.efforts?.length);
      return info?.efforts?.length ? info.efforts : factory.efforts;
    },
    setModel: (model) => set({ model }),
    setEffort: (effort) => set({ effort }),
    setDepth: (depth) => set({ depth }),
    save() {
      const fresh = loadProviders(ctx.paths) ?? file;
      saveProviders(
        ctx.paths,
        updateProfile(fresh, choice.provider, { model: choice.model, effort: choice.effort }),
      );
      return choice.provider;
    },
    types: () =>
      ctx.registry.list().map((adapterFactory) => ({
        type: adapterFactory.type,
        label: adapterFactory.label,
        ...(ACCOUNT_VAR[adapterFactory.type]
          ? { accountVar: ACCOUNT_VAR[adapterFactory.type] }
          : {}),
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
      const rest = fresh.providers.filter((provider) => provider.name !== name);
      if (rest.length === 0) throw new Error("crit: keep at least one provider");
      file = removeProfile(fresh, name, rest.find((p) => p.enabled)?.name ?? rest[0]!.name);
      saveProviders(ctx.paths, file);
      if (choice.provider === name) {
        const next = file.providers.find((provider) => provider.enabled) ?? file.providers[0]!;
        set({ provider: next.name, model: next.model ?? null, effort: next.effort ?? null });
      }
    },
  };
}

const ACCOUNT_VAR: Record<string, string> = {
  "claude-code": "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};
