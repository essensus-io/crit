import { z } from "zod";
import { Lens, Severity } from "./finding.ts";
import { RuleLayer } from "./rule.ts";

export const Depth = z.enum(["quick", "standard", "deep"]);
export type Depth = z.infer<typeof Depth>;

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
        /** Ask before starting a review estimated above this many effective tokens. */
        confirmTokens: z.number().int().positive().optional(),
        /** Stop a review once it has used this many effective tokens. */
        maxTokens: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    /** Target shard size in estimated tokens (4 chars ≈ 1 token). */
    shardTokens: z.number().int().positive().optional(),
    /** Skip files above this many tokens in whole-file scopes (name a file to review it anyway). */
    maxFileTokens: z.number().int().positive().optional(),
    /** How much review to buy: quick, standard (default) or deep. */
    depth: Depth.optional(),
  })
  .strict();
export type ConfigFile = z.infer<typeof ConfigFile>;

/** Never sent to an agent: secrets, keys and lockfiles. Naming a file does not bypass these. */
export const SECRET_IGNORES = [
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

/**
 * Not worth review tokens: docs, assets, agent config, snapshots, build output
 * and generated code. Naming the file on the command line still reviews it.
 */
export const NOISE_IGNORES = [
  "**/*.svg",
  "**/*.md",
  "**/*.mdx",
  "**/*.mdc",
  "**/*.txt",
  ".claude/**",
  ".agents/**",
  ".cursor/**",
  ".github/**",
  "**/*.snap",
  "**/__snapshots__/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/*.generated.*",
  "**/*.gen.*",
  "**/*.d.ts",
];

export const DEFAULT_IGNORES = [...SECRET_IGNORES, ...NOISE_IGNORES];

/** Extensions that are binary or media whatever their content looks like. */
export const BINARY_EXTENSIONS =
  /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|heic|otf|ttf|woff2?|eot|mp3|mp4|mov|avi|webm|wav|ogg|flac|zip|gz|tgz|bz2|xz|7z|rar|tar|pdf|psd|sketch|fig|exe|dll|so|dylib|bin|wasm|class|jar|onnx|pt|ckpt|sqlite|db)$/i;

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
  budget: { maxShards: number; maxMinutes: number; confirmTokens: number; maxTokens: number };
  shardTokens: number;
  maxFileTokens: number;
  depth: Depth;
};

export const DEFAULT_CONFIG: ResolvedConfig = {
  lenses: ["correctness", "security", "performance", "maintainability"],
  severityThreshold: "nit",
  rules: {
    sources: ["project", "global", "user"],
    include: [],
    exclude: [],
    budgetTokens: 3000,
  },
  ignore: [],
  review: { allowedCommands: [], timeoutMinutes: 15 },
  verify: { commands: [] },
  concurrency: 3,
  budget: { maxShards: 40, maxMinutes: 20, confirmTokens: 500_000, maxTokens: 2_000_000 },
  shardTokens: 30_000,
  maxFileTokens: 20_000,
  depth: "standard",
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
    if (layer.budget?.confirmTokens) out.budget.confirmTokens = layer.budget.confirmTokens;
    if (layer.budget?.maxTokens) out.budget.maxTokens = layer.budget.maxTokens;
    if (layer.shardTokens) out.shardTokens = layer.shardTokens;
    if (layer.maxFileTokens) out.maxFileTokens = layer.maxFileTokens;
    if (layer.depth) out.depth = layer.depth;
  }
  out.ignore = [...new Set(out.ignore)];
  out.rules.include = [...new Set(out.rules.include)];
  out.rules.exclude = [...new Set(out.rules.exclude)];
  return out;
}
