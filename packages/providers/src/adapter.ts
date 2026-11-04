import type {
  AdapterCapabilities,
  AgentEvent,
  AgentTask,
  DetectResult,
  ProviderProfile,
} from "@crit/schema";

/**
 * One agent CLI behind a common interface. Adding a tool (e.g. OpenCode) means
 * one more adapter and its contract tests, with no changes in core.
 */
export interface ProviderAdapter {
  /** "claude-code" | "codex" | "cursor" in v1; e.g. "opencode" later. */
  readonly type: string;
  detect(): Promise<DetectResult>;
  readonly capabilities: AdapterCapabilities;
  /**
   * Run one task headless and read-only. Findings never come through this
   * stream; they arrive through the crit MCP server (or the final JSON message
   * when the agent cannot load MCP).
   */
  run(task: AgentTask, signal: AbortSignal): AsyncIterable<AgentEvent>;
}

export type AdapterEnv = {
  env: NodeJS.ProcessEnv;
  /** Folder for temporary per-run files (MCP config, prompts). */
  tmpDir: string;
};

export type AdapterFactory = {
  type: string;
  /** Name shown in setup: "Claude Code". */
  label: string;
  /** Binary looked up on PATH during first run. */
  defaultCommand: string;
  /** Default profile name suggested during setup. */
  defaultName: string;
  /** What to tell the user when the CLI is not logged in. */
  loginHint: string;
  /** Hidden from first-run detection (the fake provider). */
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
    return factory.create(profile, env);
  }
}
