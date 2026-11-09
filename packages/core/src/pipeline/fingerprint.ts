import { createHash } from "node:crypto";
import { type Finding, SEVERITY_ORDER } from "@crit/schema";

export const normalizeCode = (s: string) => s.replace(/\s+/g, " ").trim();

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

export function titleSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 && wb.size === 0) return 1;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}

const rank = (f: Finding) => SEVERITY_ORDER.indexOf(f.severity);

function better(a: Finding, b: Finding): Finding {
  if (rank(a) !== rank(b)) return rank(a) < rank(b) ? a : b;
  if (a.confidence !== b.confidence) return a.confidence > b.confidence ? a : b;
  return a.explanation.length >= b.explanation.length ? a : b;
}

export type MergeResult = {
  findings: Finding[];
  removed: string[];
};

export function mergeFindings(input: Finding[], similarity = 0.5): MergeResult {
  const byFp = new Map<string, Finding[]>();
  for (const f of input) byFp.set(f.fingerprint, [...(byFp.get(f.fingerprint) ?? []), f]);
  const removed: string[] = [];
  const merged: Finding[] = [];
  for (const group of byFp.values()) {
    const keep = group.reduce(better);
    const others = group.filter((f) => f !== keep);
    removed.push(...others.map((other) => other.id));
    merged.push({
      ...keep,
      ruleIds: [...new Set(group.flatMap((f) => f.ruleIds))],
      mergedFrom: [...new Set([...keep.mergedFrom, ...others.map((other) => other.id)])],
    });
  }
  merged.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.range.start - b.range.start || a.id.localeCompare(b.id),
  );

  const parent = new Map(merged.map((f) => [f.id, f.id]));
  const root = (id: string): string => {
    let result = id;
    while (parent.get(result) !== result) result = parent.get(result)!;
    return result;
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
    const result = root(f.id);
    const { groupId: _g, ...rest } = f;
    return (sizes.get(result) ?? 0) > 1 ? { ...rest, groupId: result } : rest;
  });
  return { findings, removed };
}
