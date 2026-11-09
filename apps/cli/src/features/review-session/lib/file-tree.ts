import { basename, dirname } from "node:path";
import type { SessionState } from "../model/session.ts";
import { isFiltered } from "./triage.ts";

export type TreeRow = { key: string; label: string; count: number; file?: string };

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
