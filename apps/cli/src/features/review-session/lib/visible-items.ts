import { SEVERITY_ORDER } from "@crit/schema";
import type { FindingView, SessionState } from "@/features/review-session/model/session.ts";
import { type ListFilter } from "./parse-query.ts";
import { isFiltered, triage } from "./triage.ts";

export function visibleItems(state: SessionState, listFilter: ListFilter): FindingView[] {
  const q = listFilter.search?.toLowerCase();
  return state.items
    .filter((findingView) =>
      listFilter.tab === "filtered" ? isFiltered(findingView) : !isFiltered(findingView),
    )
    .filter(
      (findingView) =>
        !listFilter.severity ||
        SEVERITY_ORDER.indexOf(findingView.finding.severity) <=
          SEVERITY_ORDER.indexOf(listFilter.severity),
    )
    .filter((findingView) => !listFilter.lens || findingView.finding.category === listFilter.lens)
    .filter((findingView) => !listFilter.hasFix || Boolean(findingView.fix))
    .filter((findingView) => !listFilter.pending || triage(findingView) === "pending")
    .filter(
      (findingView) =>
        !listFilter.file ||
        findingView.finding.file.toLowerCase().includes(listFilter.file.toLowerCase()),
    )
    .filter(
      (findingView) =>
        !q ||
        findingView.finding.title.toLowerCase().includes(q) ||
        findingView.finding.file.toLowerCase().includes(q),
    )
    .sort(
      (findingView, b) =>
        findingView.finding.file.localeCompare(b.finding.file) ||
        findingView.finding.range.start - b.finding.range.start ||
        SEVERITY_ORDER.indexOf(findingView.finding.severity) -
          SEVERITY_ORDER.indexOf(b.finding.severity),
    );
}
