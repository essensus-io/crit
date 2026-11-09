import { formatTokens, SEVERITY_ORDER } from "@crit/schema";
import { type HistoryRow } from "@crit/store";
import { SEVERITY_LETTER } from "@/shared/lib/colors.ts";

export const severitySummary = (historyRow: HistoryRow) =>
  SEVERITY_ORDER.map((s) => `${historyRow.severity[s]}${SEVERITY_LETTER[s]}`).join(" ");

export const tokensLabel = (historyRow: HistoryRow) =>
  historyRow.tokens.effective > 0 ? `~${formatTokens(historyRow.tokens.effective)}` : "-";

export function outcomeOf(historyRow: HistoryRow): string {
  const st = historyRow.review.status;
  if (st === "superseded") return "superseded";
  if (st === "partial") return "partial (stopped early)";
  if (st === "running") return "running";
  if (st === "failed" || st === "cancelled") return st;
  const parts: string[] = [];
  if (historyRow.outcome.applied) parts.push(`${historyRow.outcome.applied} applied`);
  if (historyRow.outcome.dismissed) parts.push(`${historyRow.outcome.dismissed} dismissed`);
  if (parts.length === 0) return historyRow.outcome.open ? "open" : "clean";
  return parts.join(", ");
}
