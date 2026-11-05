import { estimateDurationMs, type Prepared } from "@crit/core";
import { formatTokens, type ResolvedConfig } from "@crit/schema";
import { colors, duration, plural, table, truncate } from "./ui.ts";

export type DryRunInfo = {
  provider: string;
  model: string | null;
  config: ResolvedConfig;
};

/** What a review would do and cost, without calling any agent. */
export function dryRunJson(prep: Prepared, info: DryRunInfo) {
  const reasons = new Map<string, number>();
  for (const s of prep.scope.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
  return {
    scope: prep.scope.label,
    base: prep.scope.baseRef ?? null,
    provider: info.provider,
    model: info.model,
    depth: info.config.depth,
    files: {
      total: prep.scope.files.length,
      toReview: prep.toReview.files.length,
      cached: prep.cached.size,
    },
    skipped: {
      total: prep.scope.skipped.length,
      byReason: Object.fromEntries(reasons),
      list: prep.scope.skipped,
    },
    runs: prep.runs.map((r) => ({
      label: r.label,
      lenses: r.lenses,
      files: r.files.length,
      estimatedTokens: r.estimatedTokens,
    })),
    estimate: {
      effectiveTokens: prep.estimatedTokens,
      costRatio: prep.ratio,
      minutes: Math.round(estimateDurationMs(prep.runs.length, info.config.concurrency) / 60_000),
      budgetTokens: info.config.budget.maxTokens,
      confirmAboveTokens: info.config.budget.confirmTokens,
    },
  };
}

export function renderDryRun(
  prep: Prepared,
  info: DryRunInfo,
  opts: { color: boolean; maxExamples?: number },
): string {
  const c = colors(opts.color);
  const j = dryRunJson(prep, info);
  const out: string[] = [];
  out.push(
    `${c.bold("crit review --dry-run")} · ${j.scope} · ${info.provider}${info.model ? ` (${info.model})` : ""} · depth ${j.depth}`,
  );
  out.push("");
  if (prep.scope.baseRef)
    out.push(
      `  ${c.dim("Base".padEnd(9))}${prep.scope.baseRef} ${c.dim("(--base <branch> to change)")}`,
    );
  out.push(
    `  ${c.dim("Files".padEnd(9))}${j.files.toReview} to review · ${j.files.cached} cached · ${j.skipped.total} skipped`,
  );
  const reasons = Object.entries(j.skipped.byReason).sort((a, b) => b[1] - a[1]);
  for (const [i, [reason, n]] of reasons.entries())
    out.push(`  ${c.dim((i === 0 ? "Skipped" : "").padEnd(9))}${String(n).padStart(4)}  ${reason}`);
  const examples = prep.scope.skipped.slice(0, opts.maxExamples ?? 5);
  for (const e of examples)
    out.push(`  ${" ".repeat(9)}${c.dim(`e.g. ${truncate(e.path, 70)} (${e.reason})`)}`);
  out.push("");
  if (prep.runs.length === 0) {
    out.push(
      `  ${c.green("Nothing to run")}: ${j.files.cached ? "every file is answered by the cache" : "no files to review"}.`,
    );
    return `${out.join("\n")}\n`;
  }
  if (prep.scope.spec.kind === "branch" && j.files.total > 300)
    out.push(
      `  ${" ".repeat(9)}${c.yellow(`${j.files.total} changed files is a lot for one branch: is ${prep.scope.baseRef} the right base? Try --base <branch>.`)}`,
      "",
    );
  const rows = prep.runs.map((r) => [
    "  ",
    truncate(r.label, 34),
    c.dim(r.lenses.join(", ")),
    `${plural(r.files.length, "file")}`,
    `~${formatTokens(r.estimatedTokens)}`,
  ]);
  out.push(`  ${c.dim(`Runs (${prep.runs.length})`)}`, table(rows, "  "));
  out.push("");
  const over = prep.estimatedTokens > info.config.budget.confirmTokens;
  out.push(
    `  ${c.dim("Estimate".padEnd(9))}${(over ? c.yellow : c.green)(`~${formatTokens(prep.estimatedTokens)} effective tokens`)} · ~${duration(estimateDurationMs(prep.runs.length, info.config.concurrency))} · stops at ${formatTokens(info.config.budget.maxTokens)}`,
  );
  out.push(
    `  ${" ".repeat(9)}${c.dim(`${prep.ratio}× the file size (fresh input + output + cached/10), from ${prep.ratio === 3 ? "the default" : "your past runs"}`)}`,
  );
  if (over)
    out.push(
      `  ${" ".repeat(9)}${c.yellow(`above ${formatTokens(info.config.budget.confirmTokens)}: crit asks before starting (--yes skips)`)}`,
    );
  if (prep.runs.length > info.config.budget.maxShards)
    out.push(
      `  ${" ".repeat(9)}${c.red(`${prep.runs.length} runs exceed budget.maxShards (${info.config.budget.maxShards}); raise it with --max-shards`)}`,
    );
  out.push(
    `  ${c.dim("Narrow it".padEnd(9))}${c.dim('crit review <paths>  ·  --depth quick  ·  .crit/config.json "ignore"')}`,
  );
  return `${out.join("\n")}\n`;
}
