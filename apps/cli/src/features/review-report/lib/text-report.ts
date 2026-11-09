import { formatTokens, type ReviewExport, shortId } from "@crit/schema";
import { type Colors, colors, SEVERITY_SHORT, severityColor } from "@/shared/lib/colors.ts";
import { duration, plural } from "@/shared/lib/format.ts";
import { activeFixes, reviewerTokens, sortFindings, visible } from "./report-findings.ts";

export function textReport(
  doc: ReviewExport,
  opts: { color: boolean; durationMs?: number },
): string {
  const c: Colors = colors(opts.color);
  const { review } = doc;
  const fixes = activeFixes(doc);
  const shown = sortFindings(doc.findings.filter(visible));
  const filtered = doc.findings.filter((finding) => finding.verdict === "rejected").length;
  const selected = shown.filter((f) => f.selected).length;
  const out: string[] = [];
  out.push(
    `${c.bold(`crit · review ${shortId(review.id)}`)} · ${review.scopeLabel} · ${review.provider}${review.model ? ` (${review.model})` : ""}` +
      ` · ${plural(shown.length, "finding")} · ${selected} selected${reviewerTokens(doc).effective > 0 ? ` · ~${formatTokens(reviewerTokens(doc).effective)} tokens` : ""}${opts.durationMs !== undefined ? ` · ${duration(opts.durationMs)}` : ""}`,
  );
  let file = "";
  for (const f of shown) {
    if (f.file !== file) {
      file = f.file;
      out.push("", c.bold(file));
    }
    const sev = severityColor(c, f.severity)(SEVERITY_SHORT[f.severity].padEnd(4));
    const box = f.selected ? "[x]" : "[ ]";
    const extra = [fixes.has(f.id) ? "fix" : "", f.verdict === "plausible" ? "plausible" : ""]
      .filter(Boolean)
      .join(", ");
    out.push(
      `  ${box} ${sev} ${String(f.range.start).padStart(4)}  ${f.title}${extra ? c.dim(`  (${extra})`) : ""}`,
    );
  }
  if (shown.length === 0) out.push("", c.green("No findings."));
  if (filtered)
    out.push(
      "",
      c.dim(
        `${plural(filtered, "finding")} filtered by the skeptic (crit open ${shortId(review.id)} to see them)`,
      ),
    );
  out.push(
    "",
    c.dim(
      `crit open ${shortId(review.id)} to review fixes · crit apply ${shortId(review.id)} to apply the ${selected} selected`,
    ),
  );
  return `${out.join("\n")}\n`;
}
