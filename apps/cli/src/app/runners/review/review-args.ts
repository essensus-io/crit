import { Lens, type ScopeSpec } from "@crit/schema";
import { CliError, EXIT } from "@/shared/lib/errors.ts";

export type ReviewArgs = {
  _: string[];
  all?: boolean;
  staged?: boolean;
  commit?: string;
  branch?: string;
  base?: string;
  diff?: boolean;
  provider?: string;
  lens?: string;
  tui?: boolean;
  format?: string;
  output?: string;
  yes?: boolean;
  verify?: boolean;
  cache?: boolean;
  "fail-on"?: string;
  "max-shards"?: string;
  depth?: string;
  model?: string;
  effort?: string;
  budget?: string;
  "dry-run"?: boolean;
  now?: boolean;
  gh?: boolean;
};

export function scopeFromArgs(args: ReviewArgs): ScopeSpec {
  const paths = args._.filter(Boolean);
  const kinds = [
    args.all,
    args.staged,
    args.commit !== undefined,
    args.branch !== undefined,
    paths.length > 0,
  ].filter(Boolean).length;
  if (kinds > 1)
    throw new CliError("crit: choose one scope: paths, --all, --staged, --commit or --branch", {
      exitCode: EXIT.usage,
    });
  if (args.all) return { kind: "project" };
  if (args.staged) return { kind: "staged" };
  if (args.commit !== undefined) return { kind: "commit", sha: args.commit };
  if (args.branch !== undefined)
    return { kind: "ref", ref: args.branch, ...(args.base ? { base: args.base } : {}) };
  if (paths.length)
    return {
      kind: "paths",
      paths,
      diff: Boolean(args.diff),
      ...(args.base ? { base: args.base } : {}),
    };
  return { kind: "branch", ...(args.base ? { base: args.base } : {}) };
}

export const withoutNow = (args: ReviewArgs): ReviewArgs => {
  const next = { ...args };
  delete next.now;
  return next;
};

export const withScope = (args: ReviewArgs, spec: ScopeSpec): ReviewArgs => {
  const next: ReviewArgs = { ...args };
  delete next.all;
  delete next.staged;
  delete next.commit;
  delete next.branch;
  delete next.diff;
  delete next.base;
  return { ...next, ...argsFromScope(spec) };
};

export function argsFromScope(spec: ScopeSpec): ReviewArgs {
  switch (spec.kind) {
    case "branch":
      return { _: [], ...(spec.base ? { base: spec.base } : {}) };
    case "staged":
      return { _: [], staged: true };
    case "commit":
      return { _: [], commit: spec.sha };
    case "ref":
      return { _: [], branch: spec.ref, ...(spec.base ? { base: spec.base } : {}) };
    case "project":
      return { _: [], all: true };
    case "paths":
      return {
        _: spec.paths,
        diff: spec.diff,
        ...(spec.base ? { base: spec.base } : {}),
      };
  }
}

export function parseLenses(v: string | undefined): Lens[] | undefined {
  if (!v) return undefined;
  const list = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = list.filter((l) => !Lens.safeParse(l).success);
  if (bad.length)
    throw new CliError(`crit: unknown lens ${bad.join(", ")} (use ${Lens.options.join(", ")})`, {
      exitCode: EXIT.usage,
    });
  return list as Lens[];
}

export function parseTokens(v: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(v.trim());
  if (!match)
    throw new CliError(`crit: cannot read "${v}" as a token count (try 500k or 2M)`, {
      exitCode: EXIT.usage,
    });
  const n = Math.round(
    Number(match[1]) * { "": 1, k: 1_000, m: 1_000_000 }[match[2]!.toLowerCase() as "" | "k" | "m"],
  );
  if (n < 1)
    throw new CliError("crit: the token budget must be positive", { exitCode: EXIT.usage });
  return n;
}
