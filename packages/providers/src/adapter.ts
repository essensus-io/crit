import type { ModelInfo } from "./models.ts";
import type {
  AdapterCapabilities,
  AgentEvent,
  AgentTask,
  DetectResult,
  ProviderProfile,
} from "@crit/schema";

export interface ProviderAdapter {
  readonly type: string;
  detect(): Promise<DetectResult>;
  readonly capabilities: AdapterCapabilities;
  run(task: AgentTask, signal: AbortSignal): AsyncIterable<AgentEvent>;
}

export type AdapterEnv = {
  env: NodeJS.ProcessEnv;
  tmpDir: string;
};

export type AdapterFactory = {
  type: string;
  label: string;
  defaultCommand: string;
  defaultName: string;
  loginHint: string;
  models: string[];
  listModels?(opts: {
    command: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }): Promise<ModelInfo[]>;
  defaultModelNote?: string;
  efforts: string[];
  hidden?: boolean;
  create(profile: ProviderProfile, env: AdapterEnv): ProviderAdapter;
};

export type AdapterRegistry = {
  register(factory: AdapterFactory): AdapterRegistry;
  get(type: string): AdapterFactory | undefined;
  list(options?: { includeHidden?: boolean }): AdapterFactory[];
  create(profile: ProviderProfile, env: AdapterEnv): ProviderAdapter;
};

export const createAdapterRegistry = (): AdapterRegistry => {
  const factories = new Map<string, AdapterFactory>();
  const registry: AdapterRegistry = {
    register(factory) {
      factories.set(factory.type, factory);
      return registry;
    },
    get: (type) => factories.get(type),
    list: ({ includeHidden = false } = {}) =>
      [...factories.values()].filter((factory) => includeHidden || !factory.hidden),
    create(profile, env) {
      const factory = factories.get(profile.type);
      if (!factory) {
        const known = registry
          .list({ includeHidden: true })
          .map((candidate) => candidate.type)
          .join(", ");
        throw new Error(`crit: no adapter for provider type "${profile.type}" (known: ${known})`);
      }
      return factory.create(
        profile,
        profile.env ? { ...env, env: { ...env.env, ...profile.env } } : env,
      );
    },
  };
  return registry;
};
