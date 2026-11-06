import { type Lens, SEVERITY_ORDER, type Severity } from "@crit/schema";
import { basename, dirname } from "node:path";
import type { FindingView, SessionState } from "./session.ts";

export type ListFilter = {
  tab: "findings" | "filtered";
  /** Show this severity and above; undefined = all. */
  severity?: Severity;
  lens?: Lens;
  /** Substring of the file path. */
  file?: string;
  search?: string;
  /** Only findings that have a proposed fix. */
  hasFix?: boolean;
  /** Only findings you have not ticked, skipped or applied yet. */
  pending?: boolean;
};

/** Findings the skeptic rejected, or that a re-check closed: out of the way, not gone. */
export const isFiltered = (v: FindingView) =>
  v.finding.verdict === "rejected" || v.finding.status === "closed";

/** Triage state of a finding. */
export const triage = (v: FindingView): "pending" | "accepted" | "dismissed" | "applied" =>
  v.finding.status === "applied" || v.finding.status === "fixed"
    ? "applied"
    : v.finding.status === "dismissed"
      ? "dismissed"
      : v.finding.selected
        ? "accepted"
        : "pending";

/**
 * The search box: free text plus `sev:major`, `lens:security`, `file:cart`
 * and `is:filtered`. Anything else is matched against title and path.
 */
export function parseQuery(query: string): ListFilter {
  const f: ListFilter = { tab: "findings" };
  const words: string[] = [];
  for (const tok of query.trim().split(/\s+/).filter(Boolean)) {
    const [k, ...rest] = tok.split(":");
    const v = rest.join(":");
    if (k === "sev" && (SEVERITY_ORDER as readonly string[]).includes(v))
      f.severity = v as Severity;
    else if (k === "lens" && v) f.lens = v as Lens;
    else if (k === "file" && v) f.file = v;
    else if (k === "is" && v === "filtered") f.tab = "filtered";
    else if (k === "is" && v === "pending") f.pending = true;
    else if (k === "has" && v === "fix") f.hasFix = true;
    else words.push(tok);
  }
  if (words.length) f.search = words.join(" ");
  return f;
}

/** The findings the stream shows for the current filter, in display order. */
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

export type TreeRow = { key: string; label: string; count: number; file?: string };

/** Sidebar rows: folders with counts, files under them. */
export function fileTree(state: SessionState): TreeRow[] {
  const shown = state.items.filter((v) => !isFiltered(v));
  const byDir = new Map<string, Map<string, number>>();
  for (const v of shown) {
    const d = dirname(v.finding.file);
    const files = byDir.get(d) ?? new Map<string, number>();
    files.set(v.finding.file, (files.get(v.finding.file) ?? 0) + 1);
    byDir.set(d, files);
  }
  const rows: TreeRow[] = [];
  for (const [d, files] of [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    rows.push({
      key: `d:${d}`,
      label: `▾ ${d === "." ? "(root)" : d}`,
      count: [...files.values()].reduce((a, b) => a + b, 0),
    });
    for (const [file, n] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b)))
      rows.push({ key: file, label: `    ${basename(file)}`, count: n, file });
  }
  return rows;
}
