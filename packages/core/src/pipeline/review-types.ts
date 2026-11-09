import type {
  Finding,
  FindingInput,
  ProviderProfile,
  Repo,
  ResolvedConfig,
  ResolvedScope,
  Review,
  ReviewEvent,
  ScopeSpec,
  Shard,
} from "@crit/schema";
import type { Repositories } from "@crit/store";
import type { RuleFile, RuleSet } from "../rules/index.ts";
import type { AgentRunner } from "./agent.ts";
import type { PlannedRun } from "./shards.ts";

export type ProviderRun = { profile: ProviderProfile; adapter: AgentRunner };

export type ReviewOptions = {
  cwd: string;
  spec: ScopeSpec;
  config: ResolvedConfig;
  store: Repositories;
  provider: ProviderRun;
  skeptic?: ProviderRun | null;
  sessionsDir: string;
  mcpCommand: { command: string; args: string[] };
  home: string;
  configDir: string;
  ruleFiles?: RuleFile[];
  disabledRules?: string[];
  useCache?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: ReviewEvent) => void;
  confirm?: (plan: ReviewPlan) => Promise<boolean>;
  maxRateLimitWaitMs?: number;
  now?: () => number;
};

export type ReviewPlan = {
  shards: Shard[];
  estimateMs: number;
  estimatedTokens: number;
  cachedFiles: number;
  scope: ResolvedScope;
};

export type ReviewResult = {
  review: Review;
  findings: Finding[];
  shards: Shard[];
  rules: RuleSet;
  scope: ResolvedScope;
};

export type CachedFinding = FindingInput & {
  verdict?: Finding["verdict"];
  verdictReason?: string;
};

export type Prepared = {
  scope: ResolvedScope;
  repo: Repo;
  rules: RuleSet;
  ruleById: Map<string, RuleSet["all"][number]>;
  rulesHash: string;
  cached: Map<string, CachedFinding[]>;
  toReview: ResolvedScope;
  runs: PlannedRun[];
  ratio: number;
  estimatedTokens: number;
};
