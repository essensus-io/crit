import { type ReviewExport, type Severity } from "@crit/schema";
import { sortFindings, visible } from "./report-findings.ts";

const SARIF_LEVEL: Record<Severity, "error" | "warning" | "note"> = {
  critical: "error",
  major: "error",
  minor: "warning",
  nit: "note",
};

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
