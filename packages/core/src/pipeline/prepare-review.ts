import { basename } from "node:path";
import { remoteUrl } from "../git.ts";
import { discoverRules, getDisabledRules, loadRules } from "../rules/index.ts";
import { resolveScope } from "../scope.ts";
import { CachedFile, fileCacheKey } from "./file-cache.ts";
import { readAtRevision } from "./intake.ts";
import type { CachedFinding, Prepared, ReviewOptions } from "./review-types.ts";
import { sha256 } from "./sha256.ts";
import { depthProfile, planRuns } from "./shards.ts";

export const DEFAULT_COST_RATIO = 3;

export const prepareReview = async (options: ReviewOptions): Promise<Prepared> => {
  const { store, config } = options;
  const scope = await resolveScope({
    cwd: options.cwd,
    spec: options.spec,
    ignore: config.ignore,
    maxFileTokens: config.maxFileTokens,
  });
  const repo = await store.repos.upsert({
    root: scope.root,
    remoteUrl: await remoteUrl(scope.root),
    name: basename(scope.root),
  });
  const files =
    options.ruleFiles ??
    (await discoverRules({
      root: scope.root,
      home: options.home,
      configDir: options.configDir,
      include: config.rules.include,
      sources: config.rules.sources,
    }));
  const rules = await loadRules({
    files,
    scopeFiles: scope.files.map((file) => file.path),
    nativeKinds: options.provider.adapter.capabilities.nativeContext,
    sources: config.rules.sources,
    exclude: config.rules.exclude,
    disabled: options.disabledRules ?? (await getDisabledRules(store, repo.id)),
    budgetTokens: config.rules.budgetTokens,
    tagCache: {
      get: async (hash) => {
        const value = await store.kv.get(`rule-tag:${hash}`);
        return value === undefined ? undefined : value === "1";
      },
      set: (hash, value) => store.kv.set(`rule-tag:${hash}`, value ? "1" : "0"),
    },
  });
  const rulesHash = sha256(
    rules.all
      .map((rule) => rule.hash)
      .sort()
      .join("\n"),
  );
  const ruleById = new Map([...rules.all].map((rule) => [rule.id, rule]));

  const cached = new Map<string, CachedFinding[]>();
  if (options.useCache !== false) {
    const profile = depthProfile(config);
    for (const file of scope.files) {
      if (file.status === "deleted") continue;
      const key = fileCacheKey([
        file.path,
        sha256((await readAtRevision(scope, file.path)) ?? ""),
        file.hunks ?? null,
        rulesHash,
        profile.lenses,
        options.provider.profile.type,
        options.provider.profile.name,
        options.provider.profile.model,
      ]);
      const hit = await store.cache.get(key);
      const parsed = hit ? CachedFile.safeParse(JSON.parse(hit.value)) : undefined;
      if (parsed?.success) cached.set(file.path, parsed.data.findings as CachedFinding[]);
    }
  }
  const toReview = { ...scope, files: scope.files.filter((file) => !cached.has(file.path)) };
  const runs = planRuns(toReview, config);
  const storedRatio = Number(await store.kv.get(`cost-ratio:${options.provider.profile.type}`));
  const ratio = Number.isFinite(storedRatio) && storedRatio > 0 ? storedRatio : DEFAULT_COST_RATIO;
  const estimatedTokens = Math.round(
    runs.reduce((sum, run) => sum + run.estimatedTokens, 0) * ratio,
  );
  return {
    scope,
    repo,
    rules,
    ruleById,
    rulesHash,
    cached,
    toReview,
    runs,
    ratio,
    estimatedTokens,
  };
};
