import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { estimateDurationMs, lensGroups, planShards, resolveScope, runReview } from "@crit/core";
import { resolveProvider } from "@crit/providers";
import {
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
  return (e: ReviewEvent) => {
    switch (e.type) {
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
          c.dim(`Done in ${duration(e.durationMs)} · ${plural(found, "finding")} reported\n`),
        );
        break;
    }
  };
}

export async function runReviewCommand(ctx: CliContext, args: ReviewArgs): Promise<number> {
  const maxShards = args["max-shards"] === undefined ? undefined : Number(args["max-shards"]);
  if (maxShards !== undefined && (!Number.isSafeInteger(maxShards) || maxShards < 1))
    throw new CliError("crit: --max-shards takes a positive integer", { exitCode: EXIT.usage });
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
    ...(maxShards !== undefined ? { budget: { maxShards } } : {}),
  });
  if (spec.kind === "branch" && !spec.base && config.base) spec.base = config.base;

  const resolved = resolveProvider(providers, {
    ...(args.provider ? { name: args.provider } : {}),
    ...(config.provider ? { preferred: config.provider } : {}),
  });
  for (const w of resolved.warnings) ctx.err(colors(ctx.color).yellow(`warning: ${w}\n`));
  const reviewer = { profile: resolved.profile, adapter: adapterFor(ctx, resolved.profile) };
  let skeptic: typeof reviewer | null = reviewer;
  if (args.verify === false) skeptic = null;
  else if (providers.roles.skeptic) {
    const s = resolveProvider(providers, { role: "skeptic" });
    skeptic = { profile: s.profile, adapter: adapterFor(ctx, s.profile) };
  }

  const store = ctx.openStore();
  const confirm = async ({ shards, estimateMs }: { shards: unknown[]; estimateMs: number }) => {
    if (spec.kind !== "project" || args.yes) return true;
    if (!ctx.interactive)
      throw new CliError(
        `crit: a whole-project review runs ${plural(shards.length, "shard")} (est. ${duration(estimateMs)}). Pass --yes to start it.`,
      );
    return ctx.prompter.confirm({
      message: `Review the whole project: ${plural(shards.length, "shard")}, est. ${duration(estimateMs)} on ${resolved.profile.name}. Start?`,
      initialValue: true,
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
  if (useTui) {
    // Whole-project reviews confirm here, before the screen takes over the terminal.
    if (spec.kind === "project" && !args.yes) {
      const scope = await resolveScope({ cwd: ctx.cwd, spec, ignore: config.ignore });
      const runs = planShards(scope, config.shardTokens).flatMap((p) =>
        lensGroups(config.lenses, config.shardTokens, p.estimatedTokens),
      );
      if (
        !(await confirm({
          shards: runs,
          estimateMs: estimateDurationMs(runs.length, config.concurrency),
        }))
      )
        return EXIT.cancelled;
    }
    const { runTui } = await import("../tui/start.tsx");
    const recovery = await runTui(ctx, store, root, config, (onEvent, signal) =>
      runReview({ ...base, onEvent, signal }),
    );
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
      "max-shards": {
        type: "string",
        description: "Maximum shards approved for this run (overrides the configured budget)",
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
        description: "Skip the confirmation for whole-project reviews",
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
