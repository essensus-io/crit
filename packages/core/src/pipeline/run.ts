import { createHash } from "node:crypto";
import { basename } from "node:path";
import { type RuleView, type SessionHandler, startSessionHost } from "@crit/mcp";
import {
  type AgentTask,
  type Finding,
  type FindingInput,
  FindingInput as FindingInputSchema,
  type Fix,
  newId,
  type ProviderProfile,
  type ResolvedConfig,
  type ResolvedScope,
  type Review,
  type ReviewEvent,
  type ScopeSpec,
  type Shard,
  SkepticResult,
} from "@crit/schema";
import type { Repositories } from "@crit/store";
import { z } from "zod";
import { remoteUrl } from "../git.ts";
import { discoverRules, loadRules, type RuleFile, type RuleSet } from "../rules/index.ts";
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
  SKEPTIC_SYSTEM,
  skepticPrompt,
} from "./prompts.ts";
import { depthProfile, estimateDurationMs, planRuns } from "./shards.ts";

export type ProviderRun = { profile: ProviderProfile; adapter: AgentRunner };

export type ReviewOptions = {
  cwd: string;
  spec: ScopeSpec;
  config: ResolvedConfig;
  store: Repositories;
  provider: ProviderRun;
  /** Provider for the skeptic pass; defaults to `provider`. `null` skips verification. */
  skeptic?: ProviderRun | null;
  /** Where session files for `crit mcp --session <id>` live. */
  sessionsDir: string;
  /** How agents start the crit MCP server; `--session <id>` is appended. */
  mcpCommand: { command: string; args: string[] };
  home: string;
  /** crit's personal config dir (user rules). */
  configDir: string;
  /** Rule files to use instead of discovering them (tests). */
  ruleFiles?: RuleFile[];
  /** Rule keys turned off by the user. */
  disabledRules?: string[];
  useCache?: boolean;
  signal?: AbortSignal;
  onEvent?: (e: ReviewEvent) => void;
  /** Called with the plan before running; return false to cancel. Core never prompts by itself. */
  confirm?: (plan: {
    shards: Shard[];
    estimateMs: number;
    scope: ResolvedScope;
  }) => Promise<boolean>;
  /** Cap on waiting for a rate limit to reset before giving up on a shard. */
  maxRateLimitWaitMs?: number;
  now?: () => number;
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

const CachedShard = z.object({ findings: z.array(z.any()), summary: z.string().nullable() });
const ReviewJson = z.object({ findings: z.array(z.unknown()), summary: z.string().default("") });
const SkepticJson = z.object({ results: z.array(SkepticResult) });

class CancelledError extends Error {
  override name = "CancelledError";
}

/**
 * Run a full review: resolve scope → plan shards → build context → run
 * reviewers → collect findings → merge and dedupe → verify. Emits events as it
 * goes and persists everything through the store's repositories.
 */
export async function runReview(opts: ReviewOptions): Promise<ReviewResult> {
  const now = opts.now ?? Date.now;
  const signal = opts.signal ?? new AbortController().signal;
  const emit = (e: ReviewEvent) => opts.onEvent?.(e);
  const { store, config } = opts;
  const started = now();

  // 1. Resolve scope
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

  // Rules
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
    disabled: opts.disabledRules ?? [],
    budgetTokens: config.rules.budgetTokens,
    tagCache: {
      get: async (h) => {
        const v = await store.kv.get(`rule-tag:${h}`);
        return v === undefined ? undefined : v === "1";
      },
      set: (h, v) => store.kv.set(`rule-tag:${h}`, v ? "1" : "0"),
    },
  });
  const rulesHash = sha(rules.all.map((r) => `${r.id}:${r.hash}`).join("\n"));
  const ruleById = new Map([...rules.all].map((r) => [r.id, r]));

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
  // Rule titles and paths, so a reopened review can show where each cited rule comes from.
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

  try {
    // 2. Plan shards (× lens groups)
    const shards: Shard[] = planRuns(scope, config).map((p) => ({
      id: newId(now()),
      reviewId: review.id,
      label: p.label,
      files: p.files,
      lenses: p.lenses,
      status: "queued" as const,
      estimatedTokens: p.estimatedTokens,
      inputTokens: null,
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
    if (shards.length === 0) {
      const r = await finishReview("completed", "Nothing to review in this scope.");
      emit({ type: "review-done", reviewId: r.id, findings: [], durationMs: now() - started });
      return { review: r, findings: [], shards, rules, scope };
    }
    if (opts.confirm && !(await opts.confirm({ shards, estimateMs, scope })))
      throw new CancelledError("cancelled before start");

    // 3. Map pass for whole-project reviews (cached per commit)
    let repoSummary: string | undefined;
    if (opts.spec.kind === "project") {
      const key = `map:${repo.id}:${scope.headSha ?? "none"}`;
      repoSummary = await store.kv.get(key);
      if (!repoSummary) {
        const out = await runAgent(
          opts.provider.adapter,
          {
            kind: "map",
            cwd: scope.root,
            systemPrompt: MAP_SYSTEM,
            prompt: mapPrompt(scope.files.map((f) => f.path)),
            timeoutMs: config.review.timeoutMinutes * 60_000,
            ...modelOf(opts.provider),
          },
          signal,
        );
        if (out.ok && out.message) {
          repoSummary = out.message.trim();
          await store.kv.set(key, repoSummary);
        } else
          emit({
            type: "warning",
            message: `repo map pass failed: ${out.errors.join("; ") || `exit ${out.exitCode}`}`,
          });
      }
    }

    // 4–5. Run reviewers and collect findings
    const suppressed = new Set((await store.suppressions.list(repo.id)).map((s) => s.fingerprint));
    const baseIntake = new Intake({
      scope,
      ruleIds: new Set(ruleById.keys()),
      suppressed,
      severityThreshold: config.severityThreshold,
    });
    const persist = async (
      shard: Shard,
      r: Extract<Awaited<ReturnType<Intake["check"]>>, { accepted: true }>,
    ) => {
      if (r.dropped) return undefined;
      const { fix, ...rest } = r.finding;
      const finding: Finding = {
        ...rest,
        id: newId(now()),
        reviewId: review.id,
        shardId: shard.id,
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

    const runShard = async (shard: Shard): Promise<Shard> => {
      if (signal.aborted) return store.shards.update(shard.id, { status: "cancelled" });
      const t0 = now();
      emit({ type: "shard-started", shardId: shard.id });
      await store.shards.update(shard.id, { status: "running" });
      const intake = baseIntake.restrictTo(shard.files);
      const accepted: FindingInput[] = [];

      // Cache: (content hashes, rules hash, lenses, provider, model)
      const contents = await Promise.all(
        shard.files.map(async (f) => `${f}:${sha((await readAtRevision(scope, f)) ?? "")}`),
      );
      const cacheKey = sha(
        JSON.stringify([
          contents,
          rulesHash,
          shard.lenses,
          opts.provider.profile.type,
          opts.provider.profile.name,
          opts.provider.profile.model,
          scope.spec.kind,
        ]),
      );
      if (opts.useCache !== false) {
        const hit = await store.cache.get(cacheKey);
        const parsed = hit ? CachedShard.safeParse(JSON.parse(hit.value)) : undefined;
        if (parsed?.success) {
          for (const f of parsed.data.findings as FindingInput[]) {
            const r = await intake.check(f, { allowRetry: false });
            if (r.accepted) await persist(shard, r);
          }
          return store.shards.update(shard.id, {
            status: "cached",
            summary: parsed.data.summary,
            durationMs: now() - t0,
          });
        }
      }

      let summary: string | null = null;
      const report = async (raw: FindingInput, allowRetry: boolean) => {
        const r = await intake.check(raw, { allowRetry });
        if (!r.accepted) {
          emit({ type: "finding-rejected", shardId: shard.id, errors: r.errors });
          return { accepted: false as const, errors: r.errors };
        }
        accepted.push(r.finding);
        const f = await persist(shard, r);
        return {
          accepted: true as const,
          id: f?.id ?? "suppressed",
          ...(r.warnings.length ? { warnings: r.warnings } : {}),
        };
      };

      const handler: SessionHandler = {
        getScope: async () => ({
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
        }),
        getRules: async (ids) => {
          const pool = [...rules.listed, ...rules.native, ...rules.attached, ...rules.skills];
          return pool
            .filter((r) => !ids || ids.includes(r.id))
            .map((r): RuleView => ({ id: r.id, title: r.title, path: r.path, body: r.body }));
        },
        reportFinding: (f) => report(f, true),
        finish: async (input) => {
          summary = input.coverage
            ? `${input.summary}\n\nNot covered: ${input.coverage}`
            : input.summary;
          return { ok: true };
        },
      };

      const useMcp = opts.provider.adapter.capabilities.mcp;
      const host = useMcp ? await startSessionHost({ handler, dir: opts.sessionsDir }) : undefined;
      const task: AgentTask = {
        kind: "review",
        cwd: scope.root,
        systemPrompt: reviewSystemPrompt({ mcp: useMcp }),
        prompt: reviewPrompt({
          scope,
          files: shard.files,
          lenses: shard.lenses,
          rules,
          ...(repoSummary ? { repoSummary } : {}),
        }),
        timeoutMs: config.review.timeoutMinutes * 60_000,
        allowedCommands: config.review.allowedCommands,
        ...modelOf(opts.provider),
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
          });
          if (!out.rateLimited || signal.aborted) break;
          const wait = Math.min(out.rateLimited.retryAfterMs ?? 30_000, maxWait);
          emit({ type: "rate-limited", shardId: shard.id, retryAfterMs: wait });
          if (attempt === 2 || (out.rateLimited.retryAfterMs ?? 0) > maxWait) break;
          await sleep(wait, signal);
        }
        // JSON fallback when the agent cannot load MCP, with one repair round.
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

      const failed =
        !out ||
        signal.aborted ||
        out.rateLimited !== undefined ||
        out.exitCode !== 0 ||
        (out.errors.length > 0 && accepted.length === 0);
      const status: Shard["status"] = signal.aborted ? "cancelled" : failed ? "failed" : "done";
      const updated = await store.shards.update(shard.id, {
        status,
        summary,
        inputTokens: out?.inputTokens ?? null,
        outputTokens: out?.outputTokens ?? null,
        durationMs: now() - t0,
        agentSessionId: out?.sessionId ?? null,
        error: failed
          ? out?.rateLimited
            ? "rate limited; re-run to resume"
            : out?.errors.join("; ") || `agent exited with code ${out?.exitCode}`
          : null,
      });
      if (status === "done" && opts.useCache !== false) {
        await store.cache.put({
          key: cacheKey,
          reviewId: review.id,
          value: JSON.stringify({ findings: accepted, summary }),
          transcriptPath: null,
        });
      }
      return updated;
    };

    const done: Shard[] = [];
    const queue = [...shards];
    await Promise.all(
      Array.from({ length: Math.min(config.concurrency, queue.length) }, async () => {
        while (queue.length) {
          const s = queue.shift()!;
          const r = await runShard(s);
          done.push(r);
          emit({ type: "shard-done", shard: r });
        }
      }),
    );
    if (signal.aborted) throw new CancelledError("cancelled");

    // 6. Merge and dedupe
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

    // 7. Verify with the skeptic
    // The depth decides what the skeptic checks: nothing, everything but nits, or everything.
    const mode = depthProfile(config).skeptic;
    const skeptic =
      mode === "off" ? null : opts.skeptic === undefined ? opts.provider : opts.skeptic;
    const toCheck = findings.filter((f) => mode === "all" || f.severity !== "nit");
    if (skeptic && toCheck.length > 0) {
      emit({ type: "verify-started", count: toCheck.length });
      const verdicts = await verify(toCheck, skeptic, scope, config, signal);
      for (const w of verdicts.warnings) emit({ type: "warning", message: w });
      for (const f of toCheck) {
        const v = verdicts.results.get(f.id);
        if (!v) continue;
        await store.findings.update(f.id, { verdict: v.verdict, verdictReason: v.reason });
        emit({ type: "verified", result: v });
      }
      findings = await store.findings.listByReview(review.id);
    }

    // Default checkboxes: confirmed findings with a fix start checked; plausible ones unchecked.
    for (const f of findings) {
      const hasFix = (await store.fixes.active(f.id)) !== undefined;
      const selected =
        hasFix &&
        (f.verdict === "confirmed" || (f.verdict === undefined && !skeptic && f.confidence >= 0.7));
      if (selected !== f.selected) await store.findings.update(f.id, { selected });
    }
    findings = await store.findings.listByReview(review.id);

    const failedShards = done.filter((s) => s.status === "failed");
    const summaries = done.map((s) => s.summary).filter((s): s is string => Boolean(s));
    if (failedShards.length === done.length) {
      throw new Error(
        `crit: every shard failed: ${failedShards
          .map((s) => s.error)
          .filter(Boolean)
          .join("; ")}`,
      );
    }
    for (const s of failedShards)
      emit({ type: "warning", message: `shard ${s.label} failed: ${s.error}` });
    const r = await finishReview("completed", summaries.join("\n\n") || null);
    emit({ type: "review-done", reviewId: r.id, findings, durationMs: now() - started });
    return { review: r, findings, shards: await store.shards.listByReview(r.id), rules, scope };
  } catch (err) {
    const cancelled = err instanceof CancelledError || signal.aborted;
    const message = (err as Error).message;
    await finishReview(cancelled ? "cancelled" : "failed", cancelled ? "Cancelled." : message);
    emit({ type: "review-failed", reviewId: review.id, error: message });
    throw err;
  }
}

const modelOf = (p: ProviderRun): { model?: string } =>
  p.profile.model ? { model: p.profile.model } : {};

/** Skeptic pass: confirmed / plausible / rejected per finding, in chunks, with one repair round. */
export async function verify(
  findings: Finding[],
  skeptic: ProviderRun,
  scope: ResolvedScope,
  config: Pick<ResolvedConfig, "review">,
  signal: AbortSignal,
  chunkSize = 15,
): Promise<{ results: Map<string, SkepticResult>; warnings: string[] }> {
  const results = new Map<string, SkepticResult>();
  const warnings: string[] = [];
  for (let i = 0; i < findings.length; i += chunkSize) {
    const chunk = findings.slice(i, i + chunkSize);
    const items = await Promise.all(
      chunk.map(async (f) => ({
        finding: f,
        excerpt: excerpt((await readAtRevision(scope, f.file)) ?? "", f.range),
      })),
    );
    const task: AgentTask = {
      kind: "skeptic",
      cwd: scope.root,
      systemPrompt: SKEPTIC_SYSTEM,
      prompt: skepticPrompt(items),
      timeoutMs: config.review.timeoutMinutes * 60_000,
      ...modelOf(skeptic),
    };
    let out = await runAgent(skeptic.adapter, task, signal);
    let parsed = parseJsonReply(out.message ?? "", SkepticJson);
    if (!parsed.ok && out.exitCode === 0) {
      out = await runAgent(
        skeptic.adapter,
        { ...task, prompt: `${task.prompt}\n\n${repairPrompt(parsed.error)}` },
        signal,
      );
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
  return { results, warnings };
}

/** Re-locate old findings in the current code; findings whose code is gone are closed. */
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
