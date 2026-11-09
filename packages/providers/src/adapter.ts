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

export class AdapterRegistry {
  private readonly factories = new Map<string, AdapterFactory>();

  register(factory: AdapterFactory): this {
    this.factories.set(factory.type, factory);
    return this;
  }

  get(type: string): AdapterFactory | undefined {
    return this.factories.get(type);
  }

  list(opts: { includeHidden?: boolean } = {}): AdapterFactory[] {
    return [...this.factories.values()].filter((f) => opts.includeHidden || !f.hidden);
  }

  create(profile: ProviderProfile, env: AdapterEnv): ProviderAdapter {
    const factory = this.factories.get(profile.type);
    if (!factory) {
      const known = this.list({ includeHidden: true })
        .map((f) => f.type)
        .join(", ");
      throw new Error(`crit: no adapter for provider type "${profile.type}" (known: ${known})`);
    }
    return factory.create(
      profile,
      profile.env ? { ...env, env: { ...env.env, ...profile.env } } : env,
    );
  }
}
