import {
  type Finding,
  type Fix,
  type ReviewExport,
  SEVERITY_ORDER,
  type Severity,
  shortId,
} from "@crit/schema";
import { type Colors, colors, duration, plural, SEVERITY_SHORT, severityColor } from "./ui.ts";

const visible = (f: Finding) => f.verdict !== "rejected" && f.status !== "closed";

function activeFixes(doc: ReviewExport): Map<string, Fix> {
  return new Map(doc.fixes.filter((f) => f.active).map((f) => [f.findingId, f]));
}

function sortFindings(list: Finding[]): Finding[] {
  return [...list].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.range.start - b.range.start,
  );
}

export function severityCounts(findings: Finding[]): Record<Severity, number> {
  const out: Record<Severity, number> = { critical: 0, major: 0, minor: 0, nit: 0 };
  for (const f of findings) out[f.severity]++;
  return out;
}

const loc = (f: Finding) =>
  f.range.start === f.range.end
    ? `${f.file}:${f.range.start}`
    : `${f.file}:${f.range.start}-${f.range.end}`;

/** Markdown report: header, counts, findings grouped by file with fixes as diffs, then filtered ones. */
export function markdownReport(doc: ReviewExport): string {
  const { review } = doc;
  const fixes = activeFixes(doc);
  const shown = sortFindings(doc.findings.filter(visible));
  const filtered = sortFindings(doc.findings.filter((f) => f.verdict === "rejected"));
  const counts = severityCounts(shown);
  const out: string[] = [];
  out.push(`# crit review ${shortId(review.id)}`);
  out.push("");
  out.push(`- **Scope:** ${review.scopeLabel}`);
  out.push(`- **Provider:** ${review.provider}${review.model ? ` (${review.model})` : ""}`);
  out.push(`- **Started:** ${new Date(review.startedAt).toISOString()}`);
  if (review.headSha) out.push(`- **Head:** \`${review.headSha.slice(0, 12)}\``);
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

const SARIF_LEVEL: Record<Severity, "error" | "warning" | "note"> = {
  critical: "error",
  major: "error",
  minor: "warning",
  nit: "note",
};

/** SARIF 2.1.0 for code-scanning tools. Skeptic-rejected findings are left out. */
export function sarifReport(doc: ReviewExport, toolVersion: string): object {
  const shown = sortFindings(doc.findings.filter(visible));
  const categories = [...new Set(shown.map((f) => f.category))].sort();
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "crit",
            version: toolVersion,
            informationUri: "https://github.com/crit-dev/crit",
            rules: categories.map((c) => ({
              id: `crit/${c}`,
              name: c,
              shortDescription: { text: `crit ${c} finding` },
            })),
          },
        },
        automationDetails: { id: `crit/${doc.review.id}` },
        results: shown.map((f) => ({
          ruleId: `crit/${f.category}`,
          ruleIndex: categories.indexOf(f.category),
          level: SARIF_LEVEL[f.severity],
          message: {
            text: `${f.title}\n\n${f.explanation}${f.failureScenario ? `\n\nFails when: ${f.failureScenario}` : ""}`,
          },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file, uriBaseId: "%SRCROOT%" },
                region: {
                  startLine: f.range.start,
                  endLine: f.range.end,
                  snippet: { text: f.anchor },
                },
              },
            },
          ],
          partialFingerprints: { "crit/v1": f.fingerprint },
          properties: {
            severity: f.severity,
            confidence: f.confidence,
            ...(f.verdict ? { verdict: f.verdict } : {}),
            ...(f.ruleIds.length ? { ruleIds: f.ruleIds } : {}),
          },
        })),
      },
    ],
  };
}

/** Plain-text summary for terminals and logs (the non-TUI report). */
export function textReport(
  doc: ReviewExport,
  opts: { color: boolean; durationMs?: number },
): string {
  const c: Colors = colors(opts.color);
  const { review } = doc;
  const fixes = activeFixes(doc);
  const shown = sortFindings(doc.findings.filter(visible));
  const filtered = doc.findings.filter((f) => f.verdict === "rejected").length;
  const selected = shown.filter((f) => f.selected).length;
  const out: string[] = [];
  out.push(
    `${c.bold(`crit · review ${shortId(review.id)}`)} · ${review.scopeLabel} · ${review.provider}${review.model ? ` (${review.model})` : ""}` +
      ` · ${plural(shown.length, "finding")} · ${selected} selected${opts.durationMs !== undefined ? ` · ${duration(opts.durationMs)}` : ""}`,
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
