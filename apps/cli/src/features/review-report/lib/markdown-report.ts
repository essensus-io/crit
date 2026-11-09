import { formatTokens, type ReviewExport, SEVERITY_ORDER, shortId } from "@crit/schema";
import { SEVERITY_SHORT } from "@/shared/lib/colors.ts";
import {
  activeFixes,
  loc,
  reviewerTokens,
  severityCounts,
  sortFindings,
  visible,
} from "./report-findings.ts";

export function markdownReport(doc: ReviewExport): string {
  const { review } = doc;
  const fixes = activeFixes(doc);
  const shown = sortFindings(doc.findings.filter(visible));
  const filtered = sortFindings(doc.findings.filter((finding) => finding.verdict === "rejected"));
  const counts = severityCounts(shown);
  const out: string[] = [];
  out.push(`# crit review ${shortId(review.id)}`);
  out.push("");
  out.push(`- **Scope:** ${review.scopeLabel}`);
  out.push(`- **Provider:** ${review.provider}${review.model ? ` (${review.model})` : ""}`);
  out.push(`- **Started:** ${new Date(review.startedAt).toISOString()}`);
  if (review.headSha) out.push(`- **Head:** \`${review.headSha.slice(0, 12)}\``);
  const tk = reviewerTokens(doc);
  if (tk.effective > 0)
    out.push(
      `- **Reviewer tokens:** ~${formatTokens(tk.effective)} effective (${formatTokens(tk.inputTokens)} fresh input, ${formatTokens(tk.cachedInputTokens)} cached, ${formatTokens(tk.outputTokens)} output)`,
    );
  out.push(
    `- **Findings:** ${shown.length} (${SEVERITY_ORDER.map((s) => `${counts[s]} ${s}`).join(", ")})${filtered.length ? `, ${filtered.length} filtered by the skeptic` : ""}`,
  );
  if (review.summary) {
    out.push("", "## Summary", "", review.summary);
  }
  let file = "";
  for (const f of shown) {
    if (f.file !== file) {
      file = f.file;
      out.push("", `## \`${file}\``);
    }
    out.push("", `### ${SEVERITY_SHORT[f.severity]} · ${f.title}`, "");
    const meta = [`\`${loc(f)}\``, f.category, `confidence ${f.confidence.toFixed(2)}`];
    if (f.verdict) meta.push(f.verdict);
    if (f.ruleIds.length) meta.push(`rules ${f.ruleIds.join(", ")}`);
    out.push(meta.join(" · "), "", f.explanation);
    if (f.failureScenario) out.push("", `**Fails when:** ${f.failureScenario}`);
    const fix = fixes.get(f.id);
    if (fix)
      out.push(
        "",
        `**Fix${fix.author === "user" ? " (yours)" : ""}:** ${fix.summary}`,
        "",
        "```diff",
        fix.patch.trimEnd(),
        "```",
      );
  }
  if (shown.length === 0) out.push("", "No findings.");
  if (filtered.length) {
    out.push("", "## Filtered by the skeptic", "");
    for (const f of filtered)
      out.push(`- \`${loc(f)}\` ${f.title}${f.verdictReason ? ` (${f.verdictReason})` : ""}`);
  }
  return `${out.join("\n")}\n`;
}
