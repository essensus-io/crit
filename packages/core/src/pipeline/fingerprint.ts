import { createHash } from "node:crypto";
import { type Finding, SEVERITY_ORDER } from "@crit/schema";

/** Collapse whitespace so reformatting does not change a fingerprint. */
export const normalizeCode = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Stable identity of a finding across runs and shards: file, normalized code
 * snippet and category. Line numbers are left out so edits elsewhere in the
 * file do not change it.
 */
export function fingerprint(f: Pick<Finding, "file" | "anchor" | "category">): string {
  return createHash("sha256")
    .update(`${f.file}\n${normalizeCode(f.anchor)}\n${f.category}`)
    .digest("hex")
    .slice(0, 16);
}

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((w) => w.length > 2),
  );

/** Jaccard similarity of title words, 0..1. */
export function titleSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 && wb.size === 0) return 1;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}

const rank = (f: Finding) => SEVERITY_ORDER.indexOf(f.severity);

/** Prefer the more severe, then more confident, then the one with more detail. */
function better(a: Finding, b: Finding): Finding {
  if (rank(a) !== rank(b)) return rank(a) < rank(b) ? a : b;
  if (a.confidence !== b.confidence) return a.confidence > b.confidence ? a : b;
  return a.explanation.length >= b.explanation.length ? a : b;
}

export type MergeResult = {
  findings: Finding[];
  /** Ids of findings folded into another one; delete these. */
  removed: string[];
};

/**
 * Merge duplicates across shards and lenses by fingerprint, then group findings
 * on overlapping lines of the same file with similar titles.
 */
export function mergeFindings(input: Finding[], similarity = 0.5): MergeResult {
  const byFp = new Map<string, Finding[]>();
  for (const f of input) byFp.set(f.fingerprint, [...(byFp.get(f.fingerprint) ?? []), f]);
  const removed: string[] = [];
  const merged: Finding[] = [];
  for (const group of byFp.values()) {
    const keep = group.reduce(better);
    const others = group.filter((f) => f !== keep);
    removed.push(...others.map((f) => f.id));
    merged.push({
      ...keep,
      ruleIds: [...new Set(group.flatMap((f) => f.ruleIds))],
      mergedFrom: [...new Set([...keep.mergedFrom, ...others.map((f) => f.id)])],
    });
  }
  merged.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.range.start - b.range.start || a.id.localeCompare(b.id),
  );

  // Group overlapping + similar findings (union-find over pairs in the same file).
  const parent = new Map(merged.map((f) => [f.id, f.id]));
  const root = (id: string): string => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  for (let i = 0; i < merged.length; i++) {
    for (let j = i + 1; j < merged.length; j++) {
      const a = merged[i]!;
      const b = merged[j]!;
      if (a.file !== b.file) break;
      const overlap = a.range.start <= b.range.end && b.range.start <= a.range.end;
      if (overlap && titleSimilarity(a.title, b.title) >= similarity)
        parent.set(root(b.id), root(a.id));
    }
  }
  const sizes = new Map<string, number>();
  for (const f of merged) sizes.set(root(f.id), (sizes.get(root(f.id)) ?? 0) + 1);
  const findings = merged.map((f) => {
    const r = root(f.id);
    const { groupId: _g, ...rest } = f;
    return (sizes.get(r) ?? 0) > 1 ? { ...rest, groupId: r } : rest;
  });
  return { findings, removed };
}
