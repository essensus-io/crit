import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { estimateDurationMs, prepareReview, runReview } from "@crit/core";
import { resolveProvider } from "@crit/providers";
import { Depth, formatTokens, resolveConfig, SEVERITY_ORDER, Severity } from "@crit/schema";
import { exportReview, loadProjectConfig, loadUserConfig } from "@crit/store";
import { type CliContext, sessionsDir } from "@/shared/lib/cli-context.ts";
import { CliError, EXIT } from "@/shared/lib/errors.ts";
import { dryRunJson, renderDryRun } from "@/features/review-report/lib/dry-run.ts";
import { markdownReport } from "@/features/review-report/lib/markdown-report.ts";
import { sarifReport } from "@/features/review-report/lib/sarif-report.ts";
import { textReport } from "@/features/review-report/lib/text-report.ts";
import { adapterFor } from "@/features/provider-setup/lib/adapter-for.ts";
import { ensureProviders } from "@/features/provider-setup/lib/ensure-providers.ts";
import { colors } from "@/shared/lib/colors.ts";
import { duration, plural } from "@/shared/lib/format.ts";
import { repoRootOrThrow } from "@/shared/lib/repo-root-or-throw.ts";
import { chooseReviewProvider } from "@/views/providers/choose-review-provider.ts";
import {
  type ReviewArgs,
  parseLenses,
  parseTokens,
  scopeFromArgs,
  withoutNow,
} from "./review-args.ts";
import { progressPrinter } from "./progress-printer.ts";
import { runHome } from "./run-home.ts";

export async function runReviewCommand(ctx: CliContext, args: ReviewArgs): Promise<number> {
  const maxShards = args["max-shards"] === undefined ? undefined : Number(args["max-shards"]);
  if (maxShards !== undefined && (!Number.isSafeInteger(maxShards) || maxShards < 1))
    throw new CliError("crit: --max-shards takes a positive integer", { exitCode: EXIT.usage });
  const maxTokens = args.budget === undefined ? undefined : parseTokens(args.budget);
  const depth = args.depth === undefined ? undefined : Depth.safeParse(args.depth);
  if (depth && !depth.success)
    throw new CliError(`crit: --depth takes ${Depth.options.join(", ")}`, { exitCode: EXIT.usage });
  const spec = scopeFromArgs(args);
  const format = args.format ?? "text";
  const useTui = ctx.interactive && args.tui !== false && !args.format && !args.output;
  if (!["text", "json", "md", "sarif"].includes(format))
    throw new CliError(`crit: unknown format ${format} (use json, md or sarif)`, {
      exitCode: EXIT.usage,
    });
  const failOn = args["fail-on"];
  if (failOn !== undefined && !Severity.safeParse(failOn).success)
    throw new CliError(`crit: --fail-on takes ${Severity.options.join(", ")}`, {
      exitCode: EXIT.usage,
    });

  const root = await repoRootOrThrow(ctx.cwd);
  const providers = await ensureProviders(
    ctx,
    `crit review${args._.length ? ` ${args._.join(" ")}` : ""}`,
  );
  const project = loadProjectConfig(root);
  const lenses = parseLenses(args.lens);
  const config = resolveConfig(loadUserConfig(ctx.paths), project, {
    ...(lenses ? { lenses } : {}),
    ...(args.base ? { base: args.base } : {}),
    ...(depth?.success ? { depth: depth.data } : {}),
    ...(maxShards !== undefined || maxTokens !== undefined
      ? {
          budget: {
            ...(maxShards !== undefined ? { maxShards } : {}),
            ...(maxTokens !== undefined ? { maxTokens } : {}),
          },
        }
      : {}),
  });
  if (spec.kind === "branch" && !spec.base && config.base) spec.base = config.base;

  const resolved = resolveProvider(providers, {
    ...(args.provider ? { name: args.provider } : {}),
    ...(config.provider ? { preferred: config.provider } : {}),
  });
  for (const warning of resolved.warnings)
    ctx.err(colors(ctx.color).yellow(`warning: ${warning}\n`));
  const profile = {
    ...resolved.profile,
    ...(args.model !== undefined ? { model: args.model === "default" ? null : args.model } : {}),
    ...(args.effort !== undefined
      ? { effort: args.effort === "default" ? null : args.effort }
      : {}),
  };
  const reviewer = { profile, adapter: adapterFor(ctx, profile) };
  let skeptic: typeof reviewer | null = reviewer;
  if (args.verify === false) skeptic = null;
  else if (providers.roles.skeptic) {
    const resolvedProvider = resolveProvider(providers, { role: "skeptic" });
    skeptic = {
      profile: resolvedProvider.profile,
      adapter: adapterFor(ctx, resolvedProvider.profile),
    };
  }

  const store = ctx.openStore();
  const confirm = async (plan: {
    shards: unknown[];
    estimateMs: number;
    estimatedTokens: number;
    cachedFiles: number;
  }) => {
    if (plan.shards.length === 0 || args.yes) return true;
    const big = plan.estimatedTokens > config.budget.confirmTokens;
    if (spec.kind !== "project" && !big) return true;
    const facts = `${plural(plan.shards.length, "agent run")}, ~${formatTokens(plan.estimatedTokens)} tokens, ~${duration(plan.estimateMs)} on ${resolved.profile.name}${plan.cachedFiles ? ` (${plural(plan.cachedFiles, "file")} cached)` : ""}`;
    if (!ctx.interactive)
      throw new CliError(`crit: this review is ${facts}. Pass --yes to start it.`, {
        hint: 'crit review --dry-run shows what it would do; --depth quick, paths, or .crit/config.json "ignore" narrow it.',
      });
    return ctx.prompter.confirm({
      message: `This review is ${facts}. It stops at ${formatTokens(config.budget.maxTokens)}. Start?`,
      initialValue: !big,
    });
  };
  const base = {
    cwd: ctx.cwd,
    spec,
    config,
    store,
    provider: reviewer,
    skeptic,
    sessionsDir: sessionsDir(ctx),
    mcpCommand: ctx.mcpCommand,
    home: ctx.home,
    configDir: ctx.paths.config,
    useCache: args.cache !== false,
  };
  if (useTui && !args.now && !args["dry-run"])
    return runHome(
      ctx,
      args,
      {
        root,
        store,
        config,
        profile,
        spec,
        prepare: (s) => prepareReview({ ...base, spec: s }),
      },
      runReviewCommand,
    );
  if (args["dry-run"]) {
    const prep = await prepareReview(base);
    const info = { provider: resolved.profile.name, model: resolved.profile.model, config };
    ctx.out(
      format === "json"
        ? `${JSON.stringify(dryRunJson(prep, info), null, 2)}\n`
        : renderDryRun(prep, info, { color: ctx.color }),
    );
    return EXIT.ok;
  }
  if (useTui) {
    const prep = await prepareReview(base);
    const estimateMs = estimateDurationMs(prep.runs.length, config.concurrency);
    if (
      !(await confirm({
        shards: prep.runs,
        estimateMs,
        estimatedTokens: prep.estimatedTokens,
        cachedFiles: prep.cached.size,
      }))
    )
      return EXIT.cancelled;
    const { runTui } = await import("@/views/run/launch-run.tsx");
    const recovery = await runTui(
      ctx,
      store,
      root,
      config,
      (onEvent, signal) => runReview({ ...base, onEvent, signal }),
      {
        provider: profile.name,
        model: profile.model,
        effort: profile.effort ?? null,
        depth: config.depth,
      },
    );
    if (recovery?.kind === "retry")
      return runReviewCommand(ctx, {
        ...args,
        ...(recovery.provider ? { provider: recovery.provider } : {}),
        ...(recovery.model !== undefined ? { model: recovery.model ?? "default" } : {}),
        ...(recovery.effort !== undefined ? { effort: recovery.effort ?? "default" } : {}),
        ...(recovery.depth ? { depth: recovery.depth } : {}),
        cache: !recovery.fresh,
      });
    if (recovery?.kind === "home") return runReviewCommand(ctx, withoutNow(args));
    if (recovery?.kind === "provider") {
      const provider = await chooseReviewProvider(ctx);
      return runReviewCommand(ctx, { ...args, provider });
    }
    if (recovery?.kind === "budget")
      return runReviewCommand(ctx, { ...args, "max-shards": String(recovery.maxShards) });
    return EXIT.ok;
  }
  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.once("SIGINT", onSigint);
  const t0 = ctx.now();
  try {
    const result = await runReview({
      ...base,
      signal: ac.signal,
      onEvent: progressPrinter(ctx),
      confirm,
    });
    const doc = await exportReview(store, result.review.id);
    let output: string;
    if (format === "json") output = `${JSON.stringify(doc, null, 2)}\n`;
    else if (format === "md") output = markdownReport(doc);
    else if (format === "sarif")
      output = `${JSON.stringify(sarifReport(doc, ctx.version), null, 2)}\n`;
    else output = textReport(doc, { color: ctx.color && !args.output, durationMs: ctx.now() - t0 });
    if (args.output) {
      writeFileSync(resolve(ctx.cwd, args.output), output);
      ctx.err(`Wrote ${args.output}\n`);
    } else ctx.out(output);

    if (failOn) {
      const limit = SEVERITY_ORDER.indexOf(failOn as Severity);
      const hit = result.findings.some(
        (finding) =>
          finding.verdict !== "rejected" && SEVERITY_ORDER.indexOf(finding.severity) <= limit,
      );
      if (hit) return EXIT.findings;
    }
    if (result.review.status === "partial") {
      ctx.err(colors(ctx.color).yellow(`${result.review.summary}\n`));
      return EXIT.partial;
    }
    return EXIT.ok;
  } catch (err) {
    if (ac.signal.aborted)
      throw new CliError("crit: review cancelled", { exitCode: EXIT.cancelled });
    throw err;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
