import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { estimateDurationMs, prepareReview, runReview } from "@crit/core";
import { resolveProvider } from "@crit/providers";
import {
  Depth,
  formatTokens,
  Lens,
  resolveConfig,
  type ReviewEvent,
  type ScopeSpec,
  SEVERITY_ORDER,
  Severity,
} from "@crit/schema";
import { exportReview, loadProjectConfig, loadUserConfig } from "@crit/store";
import { defineCommand } from "citty";
import { type CliContext, sessionsDir } from "../context.ts";
import { CliError, EXIT } from "../errors.ts";
import { dryRunJson, renderDryRun } from "../dryrun.ts";
import { markdownReport, sarifReport, textReport } from "../report.ts";
import { adapterFor, ensureProviders } from "../setup.ts";
import { colors, duration, plural } from "../ui.ts";
import { repoRootOrThrow } from "./shared.ts";
import { chooseReviewProvider } from "./providers.ts";

export type ReviewArgs = {
  _: string[];
  all?: boolean;
  staged?: boolean;
  commit?: string;
  base?: string;
  diff?: boolean;
  provider?: string;
  lens?: string;
  tui?: boolean;
  format?: string;
  output?: string;
  yes?: boolean;
  verify?: boolean;
  cache?: boolean;
  "fail-on"?: string;
  "max-shards"?: string;
  depth?: string;
  model?: string;
  effort?: string;
  budget?: string;
  "dry-run"?: boolean;
};

export function scopeFromArgs(args: ReviewArgs): ScopeSpec {
  const paths = args._.filter(Boolean);
  const kinds = [args.all, args.staged, args.commit !== undefined, paths.length > 0].filter(
    Boolean,
  ).length;
  if (kinds > 1)
    throw new CliError("crit: choose one scope: paths, --all, --staged or --commit", {
      exitCode: EXIT.usage,
    });
  if (args.all) return { kind: "project" };
  if (args.staged) return { kind: "staged" };
  if (args.commit !== undefined) return { kind: "commit", sha: args.commit };
  if (paths.length)
    return {
      kind: "paths",
      paths,
      diff: Boolean(args.diff),
      ...(args.base ? { base: args.base } : {}),
    };
  return { kind: "branch", ...(args.base ? { base: args.base } : {}) };
}

function parseLenses(v: string | undefined): Lens[] | undefined {
  if (!v) return undefined;
  const list = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = list.filter((l) => !Lens.safeParse(l).success);
  if (bad.length)
    throw new CliError(`crit: unknown lens ${bad.join(", ")} (use ${Lens.options.join(", ")})`, {
      exitCode: EXIT.usage,
    });
  return list as Lens[];
}

/** Progress lines for non-TUI runs, on stderr so stdout stays clean for --format. */
function progressPrinter(ctx: CliContext) {
  const c = colors(ctx.color);
  const labels = new Map<string, string>();
  let found = 0;
  let spent = 0;
  return (e: ReviewEvent) => {
    switch (e.type) {
      case "cache":
        ctx.err(
          c.dim(
            `Cache  ${plural(e.files, "file")} unchanged since their last review (${plural(e.findings, "finding")} reused)\n`,
          ),
        );
        break;
      case "usage":
        spent = e.spent;
        break;
      case "budget-stop":
        ctx.err(
          c.yellow(
            `Stopped: token budget reached (${formatTokens(e.spent)} of ${formatTokens(e.limit)})\n`,
          ),
        );
        break;
      case "rules":
        ctx.err(
          c.dim(
            `Rules  ${e.attached.length} attached, ${e.listed.length} listed only${e.conflicts.length ? `, ${plural(e.conflicts.length, "conflict")}` : ""}\n`,
          ),
        );
        break;
      case "plan":
        for (const s of e.shards) labels.set(s.id, `${s.label} · ${s.lenses.join(", ")}`);
        ctx.err(
          c.dim(`Plan   ${plural(e.shards.length, "shard")} · est. ${duration(e.estimateMs)}\n`),
        );
        break;
      case "shard-started":
        ctx.err(`◐ ${labels.get(e.shardId)}\n`);
        break;
      case "finding":
        found++;
        break;
      case "shard-done":
        ctx.err(
          `${e.shard.status === "failed" ? c.red("✗") : "✓"} ${labels.get(e.shard.id)}${e.shard.status === "cached" ? c.dim(" (cached)") : ""}${e.shard.durationMs ? c.dim(` ${duration(e.shard.durationMs)}`) : ""}${e.shard.error ? c.red(` ${e.shard.error}`) : ""}\n`,
        );
        break;
      case "rate-limited":
        ctx.err(c.yellow(`rate limited; waiting ${duration(e.retryAfterMs ?? 0)}\n`));
        break;
      case "verify-started":
        ctx.err(c.dim(`Verifying ${plural(e.count, "finding")} with the skeptic…\n`));
        break;
      case "warning":
        ctx.err(c.yellow(`warning: ${e.message}\n`));
        break;
      case "review-done":
        ctx.err(
          c.dim(
            `${e.partial ? "Stopped" : "Done"} in ${duration(e.durationMs)} · ${plural(found, "finding")} reported${spent ? ` · ~${formatTokens(spent)} effective tokens` : ""}\n`,
          ),
        );
        break;
    }
  };
}

/** "500000", "500k", "2M", "1.5m" → tokens. */
export function parseTokens(v: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(v.trim());
  if (!m)
    throw new CliError(`crit: cannot read "${v}" as a token count (try 500k or 2M)`, {
      exitCode: EXIT.usage,
    });
  const n = Math.round(
    Number(m[1]) * { "": 1, k: 1_000, m: 1_000_000 }[m[2]!.toLowerCase() as "" | "k" | "m"],
  );
  if (n < 1)
    throw new CliError("crit: the token budget must be positive", { exitCode: EXIT.usage });
  return n;
}

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
  for (const w of resolved.warnings) ctx.err(colors(ctx.color).yellow(`warning: ${w}\n`));
  // --model / --effort apply to this run only; the saved profile is not changed.
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
    const s = resolveProvider(providers, { role: "skeptic" });
    skeptic = { profile: s.profile, adapter: adapterFor(ctx, s.profile) };
  }

  const store = ctx.openStore();
  /** Ask before spending: every whole-project review, and any review estimated above budget.confirmTokens. */
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
    // Ask here, before the screen takes over the terminal.
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
    const { runTui } = await import("../tui/start.tsx");
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
        cache: true,
      });
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
        (f) => f.verdict !== "rejected" && SEVERITY_ORDER.indexOf(f.severity) <= limit,
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

export const reviewCommand = (ctx: CliContext) =>
  defineCommand({
    meta: {
      name: "review",
      description:
        "Review the current branch (default), paths, staged changes, a commit, or the whole project",
    },
    args: {
      paths: {
        type: "positional",
        required: false,
        description: "Paths, folders or globs to review",
      },
      all: { type: "boolean", description: "Review the whole project (sharded; asks to confirm)" },
      staged: { type: "boolean", description: "Review staged changes" },
      commit: { type: "string", description: "Review one commit" },
      base: { type: "string", description: "Base branch for branch reviews" },
      diff: { type: "boolean", description: "With paths: only files changed versus the base" },
      provider: { type: "string", description: "Provider profile to use for this run" },
      budget: {
        type: "string",
        description: "Stop after this many effective tokens, e.g. 500k or 2M (default 2M)",
      },
      "dry-run": {
        type: "boolean",
        description: "Show the files, skipped files, runs and token estimate; call no agent",
      },
      "max-shards": {
        type: "string",
        description: "Maximum shards approved for this run (overrides the configured budget)",
      },
      model: { type: "string", description: "Model for this run, e.g. opus or gpt-6-sol" },
      effort: { type: "string", description: "Reasoning effort for this run (low … max)" },
      depth: {
        type: "string",
        description:
          "quick (core lenses, no skeptic), standard (default) or deep (split lenses, check all)",
      },
      lens: { type: "string", description: "Limit to lenses, e.g. security,performance" },
      tui: {
        type: "boolean",
        default: true,
        description: "Open the interactive review screen (--no-tui prints a report)",
      },
      format: { type: "string", description: "Output format with --no-tui: json, md or sarif" },
      output: { type: "string", alias: "o", description: "Write the report to a file" },
      yes: {
        type: "boolean",
        alias: "y",
        description: "Skip the confirmation (whole-project and large reviews)",
      },
      verify: {
        type: "boolean",
        default: true,
        description: "Run the skeptic pass (--no-verify skips it)",
      },
      cache: {
        type: "boolean",
        default: true,
        description: "Reuse cached results for unchanged files",
      },
      "fail-on": {
        type: "string",
        description: "Exit 3 if a finding at or above this severity is found",
      },
    },
    run: async ({ args }) => {
      process.exitCode = await runReviewCommand(ctx, args as unknown as ReviewArgs);
    },
  });
