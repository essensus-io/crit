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

export function groupKey(root: string, path: string): string {
  const parts = path.split("/");
  for (let i = parts.length - 1; i >= 1; i--) {
    const dir = parts.slice(0, i).join("/");
    if (PACKAGE_MARKERS.some((m) => existsSync(join(root, dir, m)))) return dir;
  }
  return parts.length > 1 ? parts[0]! : ".";
}

export function fileTokens(scope: ResolvedScope): Map<string, number> {
  const diffChars = new Map<string, number>();
  if (scope.diff !== undefined)
    for (const parsedFile of parseUnifiedDiff(scope.diff))
      diffChars.set(diffPath(parsedFile), parsedFile.text.length);
  return new Map(
    scope.files.map((file) => [
      file.path,
      estimateTokensOf(
        scope.diff !== undefined ? (diffChars.get(file.path) ?? file.size) : file.size,
      ),
    ]),
  );
}

export function planShards(scope: ResolvedScope, shardTokens: number): PlannedShard[] {
  const tokens = fileTokens(scope);
  const files = scope.files
    .filter((file) => file.status !== "deleted")
    .map((f) => f.path)
    .sort();
  if (files.length === 0) return [];
  const total = files.reduce((file, f) => file + (tokens.get(f) ?? 0), 0);
  if (total <= shardTokens) return [{ label: scope.label, files, estimatedTokens: total }];

  const groups = new Map<string, string[]>();
  for (const file of files) {
    const k = groupKey(scope.root, file);
    groups.set(k, [...(groups.get(k) ?? []), file]);
  }

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
    chunks.forEach((chunk, i) =>
      pieces.push({
        label: chunks.length > 1 ? `${key} (${i + 1}/${chunks.length})` : key,
        files: chunk,
        estimatedTokens: sum(chunk),
        split: chunks.length > 1,
      }),
    );
  }

  const shards: Piece[] = [];
  for (const piece of pieces) {
    const fit = piece.split
      ? undefined
      : shards.find((s) => !s.split && s.estimatedTokens + piece.estimatedTokens <= shardTokens);
    if (fit) {
      fit.label = `${fit.label}, ${piece.label}`;
      fit.files.push(...piece.files);
      fit.estimatedTokens += piece.estimatedTokens;
    } else shards.push({ ...piece, files: [...piece.files] });
  }
  return shards.map(({ split: _s, ...rest }) => rest);
}

export type DepthProfile = {
  lenses: Lens[];
  split: boolean;
  skeptic: "off" | "no-nits" | "all";
};

export function depthProfile(config: { lenses: Lens[]; depth: Depth }): DepthProfile {
  if (config.depth === "quick") {
    const core = config.lenses.filter((lens) => lens === "correctness" || lens === "security");
    return {
      lenses: core.length ? core : ["correctness", "security"],
      split: false,
      skeptic: "off",
    };
  }
  if (config.depth === "deep") return { lenses: config.lenses, split: true, skeptic: "all" };
  return { lenses: config.lenses, split: false, skeptic: "no-nits" };
}

export function lensGroups(
  lenses: Lens[],
  shardTokens: number,
  estimatedTokens: number,
  split = false,
): Lens[][] {
  if (!split || estimatedTokens < shardTokens / 2 || lenses.length <= 2) return [lenses];
  const first: Lens[] = lenses.filter(
    (lens) => lens === "correctness" || lens === "security" || lens === "test",
  );
  const second = lenses.filter((lens) => !first.includes(lens));
  return [first, second].filter((g) => g.length > 0);
}

export type PlannedRun = PlannedShard & { lenses: Lens[] };

export function planRuns(
  scope: ResolvedScope,
  config: { shardTokens: number; lenses: Lens[]; depth: Depth },
): PlannedRun[] {
  const profile = depthProfile(config);
  return planShards(scope, config.shardTokens).flatMap((plannedShard) =>
    lensGroups(profile.lenses, config.shardTokens, plannedShard.estimatedTokens, profile.split).map(
      (lenses) => ({ ...plannedShard, lenses }),
    ),
  );
}

export function estimateDurationMs(runs: number, concurrency: number, perRunMs = 90_000): number {
  return Math.ceil(runs / Math.max(1, concurrency)) * perRunMs;
}
