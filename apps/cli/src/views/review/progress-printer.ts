import { formatTokens, type ReviewEvent } from "@crit/schema";
import { type CliContext } from "@/shared/lib/cli-context.ts";
import { colors } from "@/shared/lib/colors.ts";
import { duration, plural } from "@/shared/lib/format.ts";

export function progressPrinter(ctx: CliContext) {
  const c = colors(ctx.color);
  const labels = new Map<string, string>();
  let found = 0;
  let spent = 0;
  return (reviewEvent: ReviewEvent) => {
    switch (reviewEvent.type) {
      case "cache":
        ctx.err(
          c.dim(
            `Cache  ${plural(reviewEvent.files, "file")} unchanged since their last review (${plural(reviewEvent.findings, "finding")} reused)\n`,
          ),
        );
        break;
      case "usage":
        spent = reviewEvent.spent;
        break;
      case "budget-stop":
        ctx.err(
          c.yellow(
            `Stopped: token budget reached (${formatTokens(reviewEvent.spent)} of ${formatTokens(reviewEvent.limit)})\n`,
          ),
        );
        break;
      case "rules":
        ctx.err(
          c.dim(
            `Rules  ${reviewEvent.attached.length} attached, ${reviewEvent.listed.length} listed only${reviewEvent.conflicts.length ? `, ${plural(reviewEvent.conflicts.length, "conflict")}` : ""}\n`,
          ),
        );
        break;
      case "plan":
        for (const shard of reviewEvent.shards)
          labels.set(shard.id, `${shard.label} · ${shard.lenses.join(", ")}`);
        ctx.err(
          c.dim(
            `Plan   ${plural(reviewEvent.shards.length, "shard")} · est. ${duration(reviewEvent.estimateMs)}\n`,
          ),
        );
        break;
      case "shard-started":
        ctx.err(`◐ ${labels.get(reviewEvent.shardId)}\n`);
        break;
      case "finding":
        found++;
        break;
      case "shard-done":
        ctx.err(
          `${reviewEvent.shard.status === "failed" ? c.red("✗") : "✓"} ${labels.get(reviewEvent.shard.id)}${reviewEvent.shard.status === "cached" ? c.dim(" (cached)") : ""}${reviewEvent.shard.durationMs ? c.dim(` ${duration(reviewEvent.shard.durationMs)}`) : ""}${reviewEvent.shard.error ? c.red(` ${reviewEvent.shard.error}`) : ""}\n`,
        );
        break;
      case "rate-limited":
        ctx.err(c.yellow(`rate limited; waiting ${duration(reviewEvent.retryAfterMs ?? 0)}\n`));
        break;
      case "verify-started":
        ctx.err(c.dim(`Verifying ${plural(reviewEvent.count, "finding")} with the skeptic…\n`));
        break;
      case "warning":
        ctx.err(c.yellow(`warning: ${reviewEvent.message}\n`));
        break;
      case "review-done":
        ctx.err(
          c.dim(
            `${reviewEvent.partial ? "Stopped" : "Done"} in ${duration(reviewEvent.durationMs)} · ${plural(found, "finding")} reported${spent ? ` · ~${formatTokens(spent)} effective tokens` : ""}\n`,
          ),
        );
        break;
    }
  };
}
