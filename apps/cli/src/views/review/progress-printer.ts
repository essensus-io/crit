import { formatTokens, type ReviewEvent } from "@crit/schema";
import { type CliContext } from "@/shared/lib/cli-context.ts";
import { colors } from "@/shared/lib/colors.ts";
import { duration, plural } from "@/shared/lib/format.ts";

export function progressPrinter(ctx: CliContext) {
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
