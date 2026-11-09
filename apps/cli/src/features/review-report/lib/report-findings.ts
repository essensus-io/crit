import {
  addUsage,
  effectiveTokens,
  emptyUsage,
  type Finding,
  type Fix,
  type ReviewExport,
  SEVERITY_ORDER,
  type Severity,
} from "@crit/schema";

export const visible = (f: Finding) => f.verdict !== "rejected" && f.status !== "closed";

export function activeFixes(doc: ReviewExport): Map<string, Fix> {
  return new Map(doc.fixes.filter((f) => f.active).map((f) => [f.findingId, f]));
}

export function sortFindings(list: Finding[]): Finding[] {
  return [...list].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.range.start - b.range.start,
  );
}

export function reviewerTokens(doc: ReviewExport) {
  const u = doc.shards.reduce(
    (a, s) =>
      addUsage(a, {
        inputTokens: s.inputTokens ?? 0,
        cachedInputTokens: s.cachedTokens ?? 0,
        outputTokens: s.outputTokens ?? 0,
      }),
    emptyUsage(),
  );
  return { ...u, effective: effectiveTokens(u) };
}

export function severityCounts(findings: Finding[]): Record<Severity, number> {
  const out: Record<Severity, number> = { critical: 0, major: 0, minor: 0, nit: 0 };
  for (const f of findings) out[f.severity]++;
  return out;
}

export const loc = (f: Finding) =>
  f.range.start === f.range.end
    ? `${f.file}:${f.range.start}`
    : `${f.file}:${f.range.start}-${f.range.end}`;
