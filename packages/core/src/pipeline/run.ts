import { createHash } from "node:crypto";
import { basename } from "node:path";
import { type RuleView, type SessionHandler, startSessionHost } from "@crit/mcp";
import {
  addUsage,
  type AgentTask,
  effectiveTokens,
  emptyUsage,
  type Finding,
  type FindingInput,
  FindingInput as FindingInputSchema,
  type Fix,
  newId,
  type ProviderProfile,
  type Repo,
  type ResolvedConfig,
  type ResolvedScope,
  type Review,
  type ReviewEvent,
  type ScopeSpec,
  type Shard,
  SkepticResult,
  type TokenUsage,
} from "@crit/schema";
import type { Repositories } from "@crit/store";
import { z } from "zod";
import { remoteUrl } from "../git.ts";
import {
  discoverRules,
  getDisabledRules,
  loadRules,
  type RuleFile,
  type RuleSet,
} from "../rules/index.ts";
import { resolveScope } from "../scope.ts";
import { type AgentOutcome, type AgentRunner, runAgent } from "./agent.ts";
import { excerpt, reanchor } from "./anchor.ts";
import { mergeFindings } from "./fingerprint.ts";
import { Intake, readAtRevision } from "./intake.ts";
import {
  MAP_SYSTEM,
  mapPrompt,
  parseJsonReply,
  repairPrompt,
  reviewPrompt,
  reviewSystemPrompt,
  skepticSystem,
  skepticPrompt,
} from "./prompts.ts";
import { depthProfile, estimateDurationMs, type PlannedRun, planRuns } from "./shards.ts";

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
  onEvent?: (e: ReviewEvent) => void;
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

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

const CachedFile = z.object({ findings: z.array(z.any()) });

type CachedFinding = FindingInput & {
  verdict?: Finding["verdict"];
  verdictReason?: string;
};
const ReviewJson = z.object({ findings: z.array(z.unknown()), summary: z.string().default("") });
const SkepticJson = z.object({ results: z.array(SkepticResult) });

class CancelledError extends Error {
  override name = "CancelledError";
}

export const DEFAULT_COST_RATIO = 3;

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

const fileCacheKey = (parts: unknown[]) =>
  `file:${sha(JSON.stringify(["v2-skeptical-prompt", ...parts]))}`;

export async function prepareReview(opts: ReviewOptions): Promise<Prepared> {
  const { store, config } = opts;
  const scope = await resolveScope({
    cwd: opts.cwd,
    spec: opts.spec,
    ignore: config.ignore,
    maxFileTokens: config.maxFileTokens,
  });
  const repo = await store.repos.upsert({
    root: scope.root,
    remoteUrl: await remoteUrl(scope.root),
    name: basename(scope.root),
  });
  const files =
    opts.ruleFiles ??
    (await discoverRules({
      root: scope.root,
      home: opts.home,
      configDir: opts.configDir,
      include: config.rules.include,
      sources: config.rules.sources,
    }));
  const rules = await loadRules({
    files,
    scopeFiles: scope.files.map((f) => f.path),
    nativeKinds: opts.provider.adapter.capabilities.nativeContext,
    sources: config.rules.sources,
    exclude: config.rules.exclude,
    disabled: opts.disabledRules ?? (await getDisabledRules(store, repo.id)),
    budgetTokens: config.rules.budgetTokens,
    tagCache: {
      get: async (h) => {
        const v = await store.kv.get(`rule-tag:${h}`);
        return v === undefined ? undefined : v === "1";
      },
      set: (h, v) => store.kv.set(`rule-tag:${h}`, v ? "1" : "0"),
    },
  });
  const rulesHash = sha(
    rules.all
      .map((r) => r.hash)
      .sort()
      .join("\n"),
  );
  const ruleById = new Map([...rules.all].map((r) => [r.id, r]));

  const cached = new Map<string, CachedFinding[]>();
  if (opts.useCache !== false) {
    const profile = depthProfile(config);
    for (const f of scope.files) {
      if (f.status === "deleted") continue;
      const key = fileCacheKey([
        f.path,
        sha((await readAtRevision(scope, f.path)) ?? ""),
        f.hunks ?? null,
        rulesHash,
        profile.lenses,
        opts.provider.profile.type,
        opts.provider.profile.name,
        opts.provider.profile.model,
      ]);
      const hit = await store.cache.get(key);
      const parsed = hit ? CachedFile.safeParse(JSON.parse(hit.value)) : undefined;
      if (parsed?.success) cached.set(f.path, parsed.data.findings as CachedFinding[]);
    }
  }
  const toReview = { ...scope, files: scope.files.filter((f) => !cached.has(f.path)) };
  const runs = planRuns(toReview, config);
  const stored = Number(await store.kv.get(`cost-ratio:${opts.provider.profile.type}`));
  const ratio = Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_COST_RATIO;
  const estimatedTokens = Math.round(runs.reduce((n, r) => n + r.estimatedTokens, 0) * ratio);
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
}

export async function cacheKeyFor(
  prep: Prepared,
  opts: ReviewOptions,
  path: string,
): Promise<string> {
  const f = prep.scope.files.find((x) => x.path === path);
  return fileCacheKey([
    path,
    sha((await readAtRevision(prep.scope, path)) ?? ""),
    f?.hunks ?? null,
    prep.rulesHash,
    depthProfile(opts.config).lenses,
    opts.provider.profile.type,
    opts.provider.profile.name,
    opts.provider.profile.model,
  ]);
}

export async function runReview(opts: ReviewOptions): Promise<ReviewResult> {
  const now = opts.now ?? Date.now;
  const userSignal = opts.signal ?? new AbortController().signal;
  const emit = (e: ReviewEvent) => opts.onEvent?.(e);
  const { store, config } = opts;
  const started = now();

  const prep = await prepareReview(opts);
  const { scope, repo, rules, ruleById } = prep;

  let review: Review = await store.reviews.create({
    id: newId(now()),
    repoId: repo.id,
    scope: opts.spec,
    scopeLabel: scope.label,
    branch: scope.branch ?? null,
    baseSha: scope.baseSha ?? null,
    headSha: scope.headSha ?? null,
    provider: opts.provider.profile.name,
    model: opts.provider.profile.model,
    lenses: depthProfile(config).lenses,
    status: "running",
    supersededBy: null,
    summary: null,
    rulesHeader: [...rules.attached, ...rules.native].map((r) => r.id).join(","),
    startedAt: started,
    finishedAt: null,
  });
  emit({
    type: "review-started",
    reviewId: review.id,
    scope,
    provider: review.provider,
    model: review.model,
  });
  await store.events.append(review.id, "rules", {
    rules: [...rules.attached, ...rules.listed, ...rules.native, ...rules.skills].map(
      ({ id, title, path, section }) => ({ id, title, path, ...(section ? { section } : {}) }),
    ),
    conflicts: rules.conflicts,
  });
  emit({
    type: "rules",
    attached: rules.attached.map(({ id, title, path, section }) => ({
      id,
      title,
      path,
      ...(section ? { section } : {}),
    })),
    listed: [...rules.listed, ...rules.native, ...rules.skills].map(({ id, title, path }) => ({
      id,
      title,
      path,
    })),
    conflicts: rules.conflicts.map(({ topic, ruleIds }) => ({ topic, ruleIds })),
  });
  for (const e of rules.errors) emit({ type: "warning", message: e });

  const finishReview = async (status: Review["status"], summary: string | null) => {
    review = await store.reviews.update(review.id, { status, summary, finishedAt: now() });
    if (status === "completed") await store.reviews.markSuperseded(review);
    return review;
  };

  const stop = new AbortController();
  const signal = AbortSignal.any([userSignal, stop.signal]);
  let stopReason: "budget" | "rate-limit" | undefined;

  try {
    const shards: Shard[] = prep.runs.map((p) => ({
      id: newId(now()),
      reviewId: review.id,
      label: p.label,
      files: p.files,
      lenses: p.lenses,
      status: "queued" as const,
      estimatedTokens: p.estimatedTokens,
      inputTokens: null,
      cachedTokens: null,
      outputTokens: null,
      durationMs: null,
      agentSessionId: null,
      summary: null,
      error: null,
    }));
    if (shards.length > config.budget.maxShards) {
      emit({ type: "budget-exceeded", required: shards.length, limit: config.budget.maxShards });
      throw new Error(
        `crit: ${shards.length} shards exceed budget.maxShards (${config.budget.maxShards}); narrow the scope or retry with --max-shards ${shards.length}. This is a local budget, independent of your provider.`,
      );
    }
    const estimateMs = estimateDurationMs(shards.length, config.concurrency);
    for (const s of shards) await store.shards.create(s);
    emit({ type: "plan", shards, estimateMs });
    if (
      opts.confirm &&
      !(await opts.confirm({
        shards,
        estimateMs,
        estimatedTokens: prep.estimatedTokens,
        cachedFiles: prep.cached.size,
        scope,
      }))
    )
      throw new CancelledError("cancelled before start");

    const suppressed = new Set((await store.suppressions.list(repo.id)).map((s) => s.fingerprint));
    const baseIntake = new Intake({
      scope,
      ruleIds: new Set(ruleById.keys()),
      suppressed,
      severityThreshold: config.severityThreshold,
    });
    const persist = async (
      shardId: string | undefined,
      r: Extract<Awaited<ReturnType<Intake["check"]>>, { accepted: true }>,
    ) => {
      if (r.dropped) return undefined;
      const { fix, ...rest } = r.finding;
      const finding: Finding = {
        ...rest,
        id: newId(now()),
        reviewId: review.id,
        ...(shardId ? { shardId } : {}),
        fingerprint: r.fingerprint,
        status: "open",
        selected: false,
        mergedFrom: [],
        createdAt: now(),
      };
      await store.findings.create(finding);
      if (fix) {
        const f: Fix = {
          id: newId(now()),
          findingId: finding.id,
          author: "ai",
          patch: fix.patch,
          summary: fix.summary,
          overridden: false,
          active: true,
          createdAt: now(),
        };
        await store.fixes.create(f);
      }
      emit({ type: "finding", finding });
      return finding;
    };

    const reviewedOk = new Set<string>();
    const rejectedFiles = new Set<string>();
    let replayed = 0;
    for (const [path, list] of prep.cached) {
      const intake = baseIntake.restrictTo([path]);
      for (const { verdict, verdictReason, ...f } of list) {
        const r = await intake.check(f, { allowRetry: false });
        const saved = r.accepted ? await persist(undefined, r) : undefined;
        if (!saved) continue;
        replayed++;
        if (verdict)
          await store.findings.update(saved.id, {
            verdict,
            ...(verdictReason ? { verdictReason } : {}),
          });
      }
    }
    if (prep.cached.size > 0) emit({ type: "cache", files: prep.cached.size, findings: replayed });

    const maxTokens = config.budget.maxTokens;
    let finishedSpend = 0;
    const live = new Map<string, number>();
    const spent = () => finishedSpend + [...live.values()].reduce((a, b) => a + b, 0);
    let lastReported = -1;
    const report_usage = (task: "review" | "skeptic" | "map") => {
      const now_ = spent();
      if (now_ === lastReported) return;
      lastReported = now_;
      emit({ type: "usage", task, spent: now_, budget: maxTokens });
    };
    const checkBudget = () => {
      if (stopReason || spent() < maxTokens) return;
      stopReason = "budget";
      emit({ type: "budget-stop", spent: spent(), limit: maxTokens });
      stop.abort();
    };

    let repoSummary: string | undefined;
    if (opts.spec.kind === "project" && shards.length > 0) {
      const key = `map:${repo.id}`;
      const hit = await store.kv.get(key);
      const fresh = hit ? (JSON.parse(hit) as { at: number; text: string }) : undefined;
      if (fresh && now() - fresh.at < 7 * 86_400_000) repoSummary = fresh.text;
      else {
        const out = await runAgent(
          opts.provider.adapter,
          {
            kind: "map",
            cwd: scope.root,
            systemPrompt: MAP_SYSTEM,
            prompt: mapPrompt(scope.files.map((f) => f.path)),
            timeoutMs: config.review.timeoutMinutes * 60_000,
            ...modelOf(opts.provider, "fast"),
          },
          signal,
        );
        finishedSpend += effectiveTokens(out);
        report_usage("map");
        if (out.ok && out.message) {
          repoSummary = out.message.trim();
          await store.kv.set(key, JSON.stringify({ at: now(), text: repoSummary }));
        } else
          emit({
            type: "warning",
            message: `repo map pass failed: ${out.errors.join("; ") || `exit ${out.exitCode}`}`,
          });
      }
    }

    const runShard = async (shard: Shard): Promise<Shard> => {
      if (signal.aborted) return store.shards.update(shard.id, { status: "cancelled" });
      const t0 = now();
      emit({ type: "shard-started", shardId: shard.id });
      await store.shards.update(shard.id, { status: "running" });
      const intake = baseIntake.restrictTo(shard.files);
      const accepted: FindingInput[] = [];
      let toolCalls = 0;

      let summary: string | null = null;
      const report = async (raw: FindingInput, allowRetry: boolean) => {
        const r = await intake.check(raw, { allowRetry });
        if (!r.accepted) {
          emit({ type: "finding-rejected", shardId: shard.id, errors: r.errors });
          rejectedFiles.add(raw.file);
          await store.events.append(review.id, "rejected", {
            file: raw.file,
            title: raw.title,
            errors: r.errors,
          });
          return { accepted: false as const, errors: r.errors };
        }
        accepted.push(r.finding);
        if (r.dropped)
          await store.events.append(review.id, "hidden", {
            file: r.finding.file,
            title: r.finding.title,
            why: r.dropped,
          });
        const f = await persist(shard.id, r);
        return {
          accepted: true as const,
          id: f?.id ?? "suppressed",
          ...(r.warnings.length ? { warnings: r.warnings } : {}),
        };
      };

      const handler: SessionHandler = {
        getScope: async () => {
          toolCalls++;
          return {
            label: scope.label,
            files: scope.files
              .filter((f) => shard.files.includes(f.path))
              .map((f) => ({
                path: f.path,
                status: f.status,
                ...(f.hunks ? { hunks: f.hunks } : {}),
              })),
            notes: scope.diff
              ? "Report on the changed lines of these files."
              : "Report on any line of these files.",
          };
        },
        getRules: async (ids) => {
          toolCalls++;
          const pool = [...rules.listed, ...rules.native, ...rules.attached, ...rules.skills];
          return pool
            .filter((r) => !ids || ids.includes(r.id))
            .map((r): RuleView => ({ id: r.id, title: r.title, path: r.path, body: r.body }));
        },
        reportFinding: (f) => {
          toolCalls++;
          return report(f, true);
        },
        finish: async (input) => {
          toolCalls++;
          summary = input.coverage
            ? `${input.summary}\n\nNot covered: ${input.coverage}`
            : input.summary;
          return { ok: true };
        },
      };

      const useMcp = opts.provider.adapter.capabilities.mcp;
      const host = useMcp ? await startSessionHost({ handler, dir: opts.sessionsDir }) : undefined;
      const contents = new Map<string, string>();
      if (scope.diff === undefined)
        for (const f of shard.files) contents.set(f, (await readAtRevision(scope, f)) ?? "");
      const task: AgentTask = {
        kind: "review",
        cwd: scope.root,
        systemPrompt: reviewSystemPrompt({ mcp: useMcp, diff: scope.diff !== undefined }),
        prompt: reviewPrompt({
          scope,
          files: shard.files,
          lenses: shard.lenses,
          rules,
          contents,
          ...(repoSummary ? { repoSummary } : {}),
        }),
        timeoutMs: config.review.timeoutMinutes * 60_000,
        allowedCommands: config.review.allowedCommands,
        access:
          config.review.allowedCommands.length > 0 || config.depth === "deep" ? "shell" : "read",
        ...modelOf(opts.provider, "main", depthEffort(config.depth)),
        ...(host
          ? {
              mcpSession: host.sessionId,
              mcp: {
                command: opts.mcpCommand.command,
                args: [...opts.mcpCommand.args, "--session", host.sessionId],
                sessionsDir: opts.sessionsDir,
              },
            }
          : {}),
      };

      let out: AgentOutcome | undefined;
      try {
        const maxWait = opts.maxRateLimitWaitMs ?? 5 * 60_000;
        for (let attempt = 0; attempt < 3; attempt++) {
          out = await runAgent(opts.provider.adapter, task, signal, (e) => {
            if (e.type === "progress")
              emit({ type: "shard-progress", shardId: shard.id, text: e.text });
            if (e.type === "usage") {
              live.set(shard.id, effectiveTokens(e));
              report_usage("review");
              if (e.partial) checkBudget();
            }
          });
          if (!out.rateLimited || signal.aborted) break;
          const wait = Math.min(out.rateLimited.retryAfterMs ?? 30_000, maxWait);
          emit({ type: "rate-limited", shardId: shard.id, retryAfterMs: wait });
          if (attempt === 2 || (out.rateLimited.retryAfterMs ?? 0) > maxWait) break;
          await sleep(wait, signal);
        }
        if (!useMcp && out && out.exitCode === 0 && !out.rateLimited) {
          let parsed = parseJsonReply(out.message ?? "", ReviewJson);
          if (!parsed.ok) {
            const again = await runAgent(
              opts.provider.adapter,
              { ...task, prompt: `${task.prompt}\n\n${repairPrompt(parsed.error)}` },
              signal,
            );
            parsed = parseJsonReply(again.message ?? "", ReviewJson);
            out = {
              ...again,
              inputTokens: out.inputTokens + again.inputTokens,
              outputTokens: out.outputTokens + again.outputTokens,
              cachedInputTokens: out.cachedInputTokens + again.cachedInputTokens,
            };
          }
          if (parsed.ok) {
            summary = parsed.data.summary || null;
            for (const raw of parsed.data.findings) {
              const f = FindingInputSchema.safeParse(raw);
              if (f.success) await report(f.data, false);
              else
                emit({
                  type: "finding-rejected",
                  shardId: shard.id,
                  errors: f.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
                });
            }
          } else out.errors.push(`could not parse the agent's JSON output: ${parsed.error}`);
        }
      } finally {
        await host?.close();
      }

      const silent = useMcp && !!out?.ok && toolCalls === 0 && !signal.aborted;
      if (silent)
        emit({
          type: "warning",
          message: `${shard.label}: the agent finished without calling crit's tools, so nothing was recorded (run crit doctor)`,
        });
      const rateLimited = out?.rateLimited !== undefined;
      if (rateLimited && !stopReason) stopReason = "rate-limit";
      const failed =
        !out ||
        signal.aborted ||
        silent ||
        rateLimited ||
        out.exitCode !== 0 ||
        (out.errors.length > 0 && accepted.length === 0);
      const status: Shard["status"] = signal.aborted ? "cancelled" : failed ? "failed" : "done";
      const spend = out ? effectiveTokens(out) : 0;
      live.delete(shard.id);
      finishedSpend += spend;
      report_usage("review");
      const updated = await store.shards.update(shard.id, {
        status,
        summary,
        inputTokens: out?.inputTokens ?? null,
        cachedTokens: out?.cachedInputTokens ?? null,
        outputTokens: out?.outputTokens ?? null,
        durationMs: now() - t0,
        agentSessionId: out?.sessionId ?? null,
        error: failed
          ? userSignal.aborted
            ? null
            : stopReason === "budget" && signal.aborted
              ? "stopped: token budget reached"
              : silent
                ? "the agent never called crit's tools"
                : rateLimited
                  ? "rate limited; re-run to resume"
                  : out?.errors.join("; ") || `agent exited with code ${out?.exitCode}`
          : null,
      });
      if (status === "done") {
        for (const file of shard.files) if (!rejectedFiles.has(file)) reviewedOk.add(file);
        if (opts.useCache !== false) {
          for (const file of shard.files) {
            if (rejectedFiles.has(file)) continue;
            await store.cache.put({
              key: await cacheKeyFor(prep, opts, file),
              reviewId: review.id,
              value: JSON.stringify({ findings: accepted.filter((f) => f.file === file) }),
              transcriptPath: null,
            });
          }
        }
        if (shard.estimatedTokens > 0 && spend > 0) {
          const key = `cost-ratio:${opts.provider.profile.type}`;
          const next = Math.min(30, Math.max(0.5, spend / shard.estimatedTokens));
          await store.kv.set(key, String(Math.round((0.5 * prep.ratio + 0.5 * next) * 100) / 100));
        }
      }
      checkBudget();
      return updated;
    };

    const done: Shard[] = [];
    const queue = [...shards];
    await Promise.all(
      Array.from({ length: Math.min(config.concurrency, queue.length) }, async () => {
        while (queue.length && !stopReason && !signal.aborted) {
          const s = queue.shift()!;
          const r = await runShard(s);
          done.push(r);
          emit({ type: "shard-done", shard: r });
        }
      }),
    );
    if (userSignal.aborted) throw new CancelledError("cancelled");

    const all = await store.findings.listByReview(review.id);
    const merged = mergeFindings(all);
    for (const id of merged.removed) await store.findings.delete(id);
    for (const f of merged.findings)
      await store.findings.update(f.id, {
        mergedFrom: f.mergedFrom,
        ruleIds: f.ruleIds,
        ...(f.groupId ? { groupId: f.groupId } : {}),
      });
    let findings = await store.findings.listByReview(review.id);

    const mode = depthProfile(config).skeptic;
    const skeptic =
      mode === "off" ? null : opts.skeptic === undefined ? opts.provider : opts.skeptic;
    const toCheck = findings.filter(
      (f) => f.verdict === undefined && (mode === "all" || f.severity !== "nit"),
    );
    if (skeptic && toCheck.length > 0 && stopReason === "budget")
      emit({ type: "warning", message: "skeptic skipped: token budget reached" });
    else if (skeptic && toCheck.length > 0) {
      emit({ type: "verify-started", count: toCheck.length });
      const verdicts = await verify(toCheck, skeptic, scope, config, userSignal, {
        fast: mode !== "all",
        deep: mode === "all",
      });
      finishedSpend += effectiveTokens(verdicts.usage);
      report_usage("skeptic");
      await store.events.append(review.id, "usage", { task: "skeptic", ...verdicts.usage });
      for (const w of verdicts.warnings) emit({ type: "warning", message: w });
      for (const f of toCheck) {
        const v = verdicts.results.get(f.id);
        if (!v) continue;
        await store.findings.update(f.id, { verdict: v.verdict, verdictReason: v.reason });
        emit({ type: "verified", result: v });
      }
      findings = await store.findings.listByReview(review.id);
    }

    for (const f of findings) {
      const hasFix = (await store.fixes.active(f.id)) !== undefined;
      const selected =
        hasFix &&
        (f.verdict === "confirmed" || (f.verdict === undefined && !skeptic && f.confidence >= 0.7));
      if (selected !== f.selected) await store.findings.update(f.id, { selected });
    }
    findings = await store.findings.listByReview(review.id);

    if (opts.useCache !== false) {
      for (const file of reviewedOk) {
        const entries: CachedFinding[] = [];
        for (const f of findings.filter((x) => x.file === file)) {
          const fix = await store.fixes.active(f.id);
          const {
            id: _i,
            reviewId: _r,
            shardId: _s,
            fingerprint: _f,
            status: _st,
            selected: _se,
            mergedFrom: _m,
            groupId: _g,
            createdAt: _c,
            dismissReason: _d,
            ...input
          } = f;
          entries.push({
            ...input,
            ...(fix?.author === "ai" ? { fix: { summary: fix.summary, patch: fix.patch } } : {}),
          });
        }
        await store.cache.put({
          key: await cacheKeyFor(prep, opts, file),
          reviewId: review.id,
          value: JSON.stringify({ findings: entries }),
          transcriptPath: null,
        });
      }
    }

    const failedShards = done.filter((s) => s.status === "failed");
    const summaries = done.map((s) => s.summary).filter((s): s is string => Boolean(s));
    if (failedShards.length === done.length && done.length > 0 && !stopReason) {
      throw new Error(
        `crit: every shard failed: ${failedShards
          .map((s) => s.error)
          .filter(Boolean)
          .join("; ")}`,
      );
    }
    for (const s of failedShards)
      emit({ type: "warning", message: `shard ${s.label} failed: ${s.error}` });
    const ran = done.filter((s) => s.status === "done").length;
    const partial =
      stopReason && ran < shards.length
        ? stopReason === "budget"
          ? `Stopped at the ${config.budget.maxTokens.toLocaleString("en-US")}-token budget after ${ran} of ${shards.length} runs. Findings so far are kept; run again to resume (finished files are cached), or raise the budget with --budget.`
          : `Stopped early because the provider is rate limited, after ${ran} of ${shards.length} runs. Findings so far are kept; run again later to resume (finished files are cached).`
        : undefined;
    const r = await finishReview(
      partial ? "partial" : "completed",
      partial ??
        (summaries.join("\n\n") ||
          (shards.length === 0
            ? prep.cached.size > 0
              ? `All ${prep.cached.size} files are unchanged since their last review; results come from the cache.`
              : "Nothing to review in this scope."
            : null)),
    );
    emit({
      type: "review-done",
      reviewId: r.id,
      findings,
      durationMs: now() - started,
      ...(partial ? { partial } : {}),
    });
    return { review: r, findings, shards: await store.shards.listByReview(r.id), rules, scope };
  } catch (err) {
    const cancelled = err instanceof CancelledError || userSignal.aborted;
    const message = (err as Error).message;
    await finishReview(cancelled ? "cancelled" : "failed", cancelled ? "Cancelled." : message);
    emit({ type: "review-failed", reviewId: review.id, error: message });
    throw err;
  }
}

const modelOf = (
  p: ProviderRun,
  kind: "main" | "fast" = "main",
  depthEffort?: string,
): { model?: string; effort?: string } => {
  const model = (kind === "fast" && p.profile.fastModel) || p.profile.model;
  const effort = kind === "fast" ? "low" : (p.profile.effort ?? depthEffort);
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
};

export const depthEffort = (depth: ResolvedConfig["depth"]): string | undefined =>
  depth === "quick" ? "low" : depth === "deep" ? "high" : undefined;

export async function verify(
  findings: Finding[],
  skeptic: ProviderRun,
  scope: ResolvedScope,
  config: Pick<ResolvedConfig, "review">,
  signal: AbortSignal,
  opts: { fast?: boolean; deep?: boolean; chunkSize?: number } = {},
): Promise<{ results: Map<string, SkepticResult>; warnings: string[]; usage: TokenUsage }> {
  const chunkSize = opts.chunkSize ?? 15;
  const results = new Map<string, SkepticResult>();
  const warnings: string[] = [];
  let usage = emptyUsage();
  for (let i = 0; i < findings.length; i += chunkSize) {
    const chunk = findings.slice(i, i + chunkSize);
    const items = await Promise.all(
      chunk.map(async (f) => ({
        finding: f,
        excerpt: excerpt((await readAtRevision(scope, f.file)) ?? "", f.range, opts.deep ? 6 : 20),
      })),
    );
    const task: AgentTask = {
      kind: "skeptic",
      cwd: scope.root,
      systemPrompt: skepticSystem(opts.deep === true),
      access: opts.deep ? "read" : "none",
      prompt: skepticPrompt(items),
      timeoutMs: config.review.timeoutMinutes * 60_000,
      ...modelOf(skeptic, opts.fast ? "fast" : "main"),
    };
    let out = await runAgent(skeptic.adapter, task, signal);
    usage = addUsage(usage, out);
    let parsed = parseJsonReply(out.message ?? "", SkepticJson);
    if (!parsed.ok && out.exitCode === 0) {
      out = await runAgent(
        skeptic.adapter,
        { ...task, prompt: `${task.prompt}\n\n${repairPrompt(parsed.error)}` },
        signal,
      );
      usage = addUsage(usage, out);
      parsed = parseJsonReply(out.message ?? "", SkepticJson);
    }
    if (!parsed.ok) {
      warnings.push(
        `skeptic pass failed for ${chunk.length} findings: ${out.errors.join("; ") || parsed.error}`,
      );
      continue;
    }
    const ids = new Set(chunk.map((f) => f.id));
    for (const r of parsed.data.results) if (ids.has(r.findingId)) results.set(r.findingId, r);
    for (const f of chunk) {
      if (!results.has(f.id))
        results.set(f.id, {
          findingId: f.id,
          verdict: "plausible",
          reason: "the skeptic gave no verdict",
        });
    }
  }
  return { results, warnings, usage };
}

export async function reanchorFindings(
  store: Repositories,
  scope: ResolvedScope,
  findings: Finding[],
): Promise<{ moved: number; closed: number }> {
  let moved = 0;
  let closed = 0;
  for (const f of findings) {
    if (f.status !== "open") continue;
    const content = await readAtRevision(scope, f.file);
    const range = content === undefined ? undefined : reanchor(content, f.anchor, f.range);
    if (!range) {
      await store.findings.update(f.id, { status: "closed", selected: false });
      closed++;
    } else if (range.start !== f.range.start || range.end !== f.range.end) {
      await store.findings.update(f.id, { range });
      moved++;
    }
  }
  return { moved, closed };
}
