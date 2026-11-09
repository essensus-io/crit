import { formatTokens, SEVERITY_ORDER } from "@crit/schema";
import { type HistoryRow } from "@crit/store";
import { SEVERITY_LETTER } from "@/shared/lib/colors.ts";

export const severitySummary = (r: HistoryRow) =>
  SEVERITY_ORDER.map((s) => `${r.severity[s]}${SEVERITY_LETTER[s]}`).join(" ");

export const tokensLabel = (r: HistoryRow) =>
  r.tokens.effective > 0 ? `~${formatTokens(r.tokens.effective)}` : "-";

export function outcomeOf(r: HistoryRow): string {
  const st = r.review.status;
  if (st === "superseded") return "superseded";
  if (st === "partial") return "partial (stopped early)";
  if (st === "running") return "running";
  if (st === "failed" || st === "cancelled") return st;
  const parts: string[] = [];
  if (r.outcome.applied) parts.push(`${r.outcome.applied} applied`);
  if (r.outcome.dismissed) parts.push(`${r.outcome.dismissed} dismissed`);
  if (parts.length === 0) return r.outcome.open ? "open" : "clean";
  return parts.join(", ");
}
