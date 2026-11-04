import { z } from "zod";
import { Lens, Severity } from "./finding.ts";
import { RuleLayer } from "./rule.ts";

/**
 * `.crit/config.json` (team) merged over `~/.config/crit/config.json` (personal).
 * Every field is optional; `resolveConfig` fills defaults.
 */
export const ConfigFile = z
  .object({
    $schema: z.string().optional(),
    /** Preferred provider profile name; falls back to the user's default with a warning. */
    provider: z.string().optional(),
    /** Base branch for branch reviews. Detected from upstream / origin/HEAD when unset. */
    base: z.string().optional(),
    lenses: z.array(Lens).min(1).optional(),
    severityThreshold: Severity.optional(),
    rules: z
      .object({
        sources: z.array(RuleLayer).optional(),
        include: z.array(z.string()).optional(),
        /** `path` or `path#Section heading` */
        exclude: z.array(z.string()).optional(),
        /** Max tokens of rule text inlined into the prompt. */
        budgetTokens: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    ignore: z.array(z.string()).optional(),
    review: z
      .object({
        allowedCommands: z.array(z.string()).optional(),
        timeoutMinutes: z.number().positive().optional(),
      })
      .strict()
      .optional(),
    verify: z
      .object({
        commands: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    concurrency: z.number().int().min(1).max(16).optional(),
    budget: z
      .object({
        maxShards: z.number().int().positive().optional(),
        maxMinutes: z.number().positive().optional(),
      })
      .strict()
      .optional(),
    /** Target shard size in estimated tokens (4 chars ≈ 1 token). */
    shardTokens: z.number().int().positive().optional(),
  })
  .strict();
export type ConfigFile = z.infer<typeof ConfigFile>;

export const DEFAULT_IGNORES = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.crt",
  "**/*.cer",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/*.lock",
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/*.min.js",
  "**/*.map",
];

/** Fully resolved config with defaults applied. */
export type ResolvedConfig = {
  provider?: string;
  base?: string;
  lenses: Lens[];
  severityThreshold: Severity;
  rules: {
    sources: RuleLayer[];
    include: string[];
    exclude: string[];
    budgetTokens: number;
  };
  ignore: string[];
  review: { allowedCommands: string[]; timeoutMinutes: number };
  verify: { commands: string[] };
  concurrency: number;
  budget: { maxShards: number; maxMinutes: number };
  shardTokens: number;
};

export const DEFAULT_CONFIG: ResolvedConfig = {
  lenses: ["correctness", "security", "performance", "maintainability"],
  severityThreshold: "nit",
  rules: {
    sources: ["project", "global", "user"],
    include: [],
    exclude: [],
    budgetTokens: 8000,
  },
  ignore: [],
  review: { allowedCommands: [], timeoutMinutes: 15 },
  verify: { commands: [] },
  concurrency: 3,
  budget: { maxShards: 40, maxMinutes: 20 },
  shardTokens: 60_000,
};

/**
 * Merge config layers, later layers win. Arrays replace, except `ignore`,
 * `rules.include` and `rules.exclude`, which accumulate across layers.
 */
export function resolveConfig(...layers: (ConfigFile | undefined)[]): ResolvedConfig {
  const out: ResolvedConfig = structuredClone(DEFAULT_CONFIG);
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.provider !== undefined) out.provider = layer.provider;
    if (layer.base !== undefined) out.base = layer.base;
    if (layer.lenses) out.lenses = [...layer.lenses];
    if (layer.severityThreshold) out.severityThreshold = layer.severityThreshold;
    if (layer.rules?.sources) out.rules.sources = [...layer.rules.sources];
    if (layer.rules?.include) out.rules.include.push(...layer.rules.include);
    if (layer.rules?.exclude) out.rules.exclude.push(...layer.rules.exclude);
    if (layer.rules?.budgetTokens) out.rules.budgetTokens = layer.rules.budgetTokens;
    if (layer.ignore) out.ignore.push(...layer.ignore);
    if (layer.review?.allowedCommands)
      out.review.allowedCommands = [...layer.review.allowedCommands];
    if (layer.review?.timeoutMinutes) out.review.timeoutMinutes = layer.review.timeoutMinutes;
    if (layer.verify?.commands) out.verify.commands = [...layer.verify.commands];
    if (layer.concurrency) out.concurrency = layer.concurrency;
    if (layer.budget?.maxShards) out.budget.maxShards = layer.budget.maxShards;
    if (layer.budget?.maxMinutes) out.budget.maxMinutes = layer.budget.maxMinutes;
    if (layer.shardTokens) out.shardTokens = layer.shardTokens;
  }
  out.ignore = [...new Set(out.ignore)];
  out.rules.include = [...new Set(out.rules.include)];
  out.rules.exclude = [...new Set(out.rules.exclude)];
  return out;
}
