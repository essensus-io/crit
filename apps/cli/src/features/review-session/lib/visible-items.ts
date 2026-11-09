import { SEVERITY_ORDER } from "@crit/schema";
import type { FindingView, SessionState } from "@/features/review-session/model/session.ts";
import { type ListFilter } from "./parse-query.ts";
import { isFiltered, triage } from "./triage.ts";

export function visibleItems(state: SessionState, f: ListFilter): FindingView[] {
  const q = f.search?.toLowerCase();
  return state.items
    .filter((v) => (f.tab === "filtered" ? isFiltered(v) : !isFiltered(v)))
    .filter(
      (v) =>
        !f.severity ||
        SEVERITY_ORDER.indexOf(v.finding.severity) <= SEVERITY_ORDER.indexOf(f.severity),
    )
    .filter((v) => !f.lens || v.finding.category === f.lens)
    .filter((v) => !f.hasFix || Boolean(v.fix))
    .filter((v) => !f.pending || triage(v) === "pending")
    .filter((v) => !f.file || v.finding.file.toLowerCase().includes(f.file.toLowerCase()))
    .filter(
      (v) =>
        !q || v.finding.title.toLowerCase().includes(q) || v.finding.file.toLowerCase().includes(q),
    )
    .sort(
      (a, b) =>
        a.finding.file.localeCompare(b.finding.file) ||
        a.finding.range.start - b.finding.range.start ||
        SEVERITY_ORDER.indexOf(a.finding.severity) - SEVERITY_ORDER.indexOf(b.finding.severity),
    );
}
