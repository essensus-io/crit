import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Depth, Lens, ResolvedScope } from "@crit/schema";
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

/**
 * Token estimate per file. Diff scopes count the diff only: the agent reviews
 * from it and reads a file only to check a suspicion. Whole-file scopes count
 * the file, which is inlined into the prompt.
 */
export function fileTokens(scope: ResolvedScope): Map<string, number> {
  const diffChars = new Map<string, number>();
  if (scope.diff !== undefined)
    for (const f of parseUnifiedDiff(scope.diff)) diffChars.set(diffPath(f), f.text.length);
  return new Map(
    scope.files.map((f) => [
      f.path,
      estimateTokensOf(scope.diff !== undefined ? (diffChars.get(f.path) ?? f.size) : f.size),
    ]),
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

export type DepthProfile = {
  /** Lenses this depth reviews. */
  lenses: Lens[];
  /** Split big shards into a correctness/security pass and a quality pass. */
  split: boolean;
  /** Which findings the skeptic checks: none, all but nits, or every one. */
  skeptic: "off" | "no-nits" | "all";
};

/**
 * What each depth buys: quick reviews only correctness and security with no
 * skeptic; standard reviews every configured lens in one pass per shard and
 * skips nits in the skeptic; deep splits big shards by lens and checks all.
 */
export function depthProfile(config: { lenses: Lens[]; depth: Depth }): DepthProfile {
  if (config.depth === "quick") {
    const core = config.lenses.filter((l) => l === "correctness" || l === "security");
    return {
      lenses: core.length ? core : ["correctness", "security"],
      split: false,
      skeptic: "off",
    };
  }
  if (config.depth === "deep") return { lenses: config.lenses, split: true, skeptic: "all" };
  return { lenses: config.lenses, split: false, skeptic: "no-nits" };
}

/**
 * Lens groups per shard. One pass with every lens unless `split` is on and the
 * shard is at least half full, when it becomes a correctness/security pass and
 * a quality pass.
 */
export function lensGroups(
  lenses: Lens[],
  shardTokens: number,
  estimatedTokens: number,
  split = false,
): Lens[][] {
  if (!split || estimatedTokens < shardTokens / 2 || lenses.length <= 2) return [lenses];
  const first: Lens[] = lenses.filter(
    (l) => l === "correctness" || l === "security" || l === "test",
  );
  const second = lenses.filter((l) => !first.includes(l));
  return [first, second].filter((g) => g.length > 0);
}

export type PlannedRun = PlannedShard & { lenses: Lens[] };

/** Every agent run a review will make: shards × lens groups, for the configured depth. */
export function planRuns(
  scope: ResolvedScope,
  config: { shardTokens: number; lenses: Lens[]; depth: Depth },
): PlannedRun[] {
  const profile = depthProfile(config);
  return planShards(scope, config.shardTokens).flatMap((p) =>
    lensGroups(profile.lenses, config.shardTokens, p.estimatedTokens, profile.split).map(
      (lenses) => ({ ...p, lenses }),
    ),
  );
}

/** Rough wall-clock estimate for confirming whole-project reviews. */
export function estimateDurationMs(runs: number, concurrency: number, perRunMs = 90_000): number {
  return Math.ceil(runs / Math.max(1, concurrency)) * perRunMs;
}
