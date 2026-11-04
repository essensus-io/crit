import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Lens, ResolvedScope } from "@crit/schema";
import { diffPath, parseUnifiedDiff } from "../diff.ts";

export const CHARS_PER_TOKEN = 4;
export const estimateTokensOf = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

const PACKAGE_MARKERS = [
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "composer.json",
  "Gemfile",
];

export type PlannedShard = {
  label: string;
  files: string[];
  estimatedTokens: number;
};

/** Package folder (nearest marker file) or top-level folder of a path. */
export function groupKey(root: string, path: string): string {
  const parts = path.split("/");
  for (let i = parts.length - 1; i >= 1; i--) {
    const dir = parts.slice(0, i).join("/");
    if (PACKAGE_MARKERS.some((m) => existsSync(join(root, dir, m)))) return dir;
  }
  return parts.length > 1 ? parts[0]! : ".";
}

/** Token estimate per file: its diff (for diff scopes) plus the file itself, which the agent reads. */
export function fileTokens(scope: ResolvedScope): Map<string, number> {
  const diffChars = new Map<string, number>();
  if (scope.diff)
    for (const f of parseUnifiedDiff(scope.diff)) diffChars.set(diffPath(f), f.text.length);
  return new Map(
    scope.files.map((f) => [f.path, estimateTokensOf(f.size + (diffChars.get(f.path) ?? 0))]),
  );
}

/**
 * Group files by package or top-level folder into shards of about
 * `shardTokens`. A scope under the limit is one shard. Groups are kept
 * together when they fit; oversized groups are split in path order.
 */
export function planShards(scope: ResolvedScope, shardTokens: number): PlannedShard[] {
  const tokens = fileTokens(scope);
  const files = scope.files
    .filter((f) => f.status !== "deleted")
    .map((f) => f.path)
    .sort();
  if (files.length === 0) return [];
  const total = files.reduce((n, f) => n + (tokens.get(f) ?? 0), 0);
  if (total <= shardTokens) return [{ label: scope.label, files, estimatedTokens: total }];

  const groups = new Map<string, string[]>();
  for (const f of files) {
    const k = groupKey(scope.root, f);
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }

  // Split oversized groups into numbered chunks; keep the rest whole.
  type Piece = PlannedShard & { split: boolean };
  const pieces: Piece[] = [];
  for (const [key, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const chunks: string[][] = [[]];
    let size = 0;
    for (const f of list) {
      const t = tokens.get(f) ?? 0;
      if (chunks.at(-1)!.length > 0 && size + t > shardTokens) {
        chunks.push([]);
        size = 0;
      }
      chunks.at(-1)!.push(f);
      size += t;
    }
    const sum = (fs: string[]) => fs.reduce((n, f) => n + (tokens.get(f) ?? 0), 0);
    chunks.forEach((c, i) =>
      pieces.push({
        label: chunks.length > 1 ? `${key} (${i + 1}/${chunks.length})` : key,
        files: c,
        estimatedTokens: sum(c),
        split: chunks.length > 1,
      }),
    );
  }

  // Pack whole groups together (first fit, in order) so small folders share a run.
  const shards: Piece[] = [];
  for (const p of pieces) {
    const fit = p.split
      ? undefined
      : shards.find((s) => !s.split && s.estimatedTokens + p.estimatedTokens <= shardTokens);
    if (fit) {
      fit.label = `${fit.label}, ${p.label}`;
      fit.files.push(...p.files);
      fit.estimatedTokens += p.estimatedTokens;
    } else shards.push({ ...p, files: [...p.files] });
  }
  return shards.map(({ split: _s, ...rest }) => rest);
}

/**
 * Lens groups per shard: small scopes run all lenses in one pass; larger
 * shards split into a correctness/security pass and a quality pass.
 */
export function lensGroups(lenses: Lens[], shardTokens: number, estimatedTokens: number): Lens[][] {
  if (estimatedTokens < shardTokens / 2 || lenses.length <= 2) return [lenses];
  const first: Lens[] = lenses.filter(
    (l) => l === "correctness" || l === "security" || l === "test",
  );
  const second = lenses.filter((l) => !first.includes(l));
  return [first, second].filter((g) => g.length > 0);
}

/** Rough wall-clock estimate for confirming whole-project reviews. */
export function estimateDurationMs(runs: number, concurrency: number, perRunMs = 90_000): number {
  return Math.ceil(runs / Math.max(1, concurrency)) * perRunMs;
}
