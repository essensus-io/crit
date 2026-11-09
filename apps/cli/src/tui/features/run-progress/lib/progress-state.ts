import { formatTokens, type ReviewEvent, type Shard } from "@crit/schema";
import { SEV_LABEL, type Tone } from "../../../shared/lib/index.ts";

export type LogEntry = { at: number; tag: string; text: string; tone: Tone | "dim" };

export type ProgressState = {
  header?: string;
  startedAt?: number;
  scope?: { label: string; files: number; skipped: number };
  provider?: string;
  model?: string | null;
  shards: Map<
    string,
    { shard: Shard; status: Shard["status"]; text?: string; findings: number; durationMs?: number }
  >;
  rules?: { attached: string[]; listed: number; conflicts: number };
  cache?: { files: number; findings: number };
  findings: number;
  verifying?: number;
  verified: number;
  tokens?: { spent: number; budget: number };
  log: LogEntry[];
  warnings: string[];
  done?: boolean;
  failed?: string;
  partial?: string;
  budget?: { required: number; limit: number };
  rateLimited?: boolean;
};

const MAX_LOG = 500;

export type RunRecovery =
  | { kind: "provider" }
  /** Back to the start screen. */
  | { kind: "home" }
  | { kind: "budget"; maxShards: number }
  /** Run again with what the user picked on the run screen. */
  | {
      kind: "retry";
      provider?: string;
      model?: string | null;
      effort?: string | null;
      depth?: string;
      /** Review every file again instead of reusing the last result. */
      fresh?: boolean;
    };

export const emptyProgress = (): ProgressState => ({
  shards: new Map(),
  findings: 0,
  verified: 0,
  log: [],
  warnings: [],
});

/** Fold a review event into the progress state (pure, for tests). */
export function reduceProgress(p: ProgressState, e: ReviewEvent, now = Date.now()): ProgressState {
  const shards = new Map(p.shards);
  const log = (tag: string, text: string, tone: LogEntry["tone"] = "dim"): LogEntry[] =>
    [...p.log, { at: now, tag, text, tone }].slice(-MAX_LOG);
  const name = (id: string) => p.shards.get(id)?.shard.label ?? id;
  switch (e.type) {
    case "review-started":
      return {
        ...p,
        startedAt: p.startedAt ?? now,
        header: `${e.scope.label} · ${e.provider}${e.model ? ` (${e.model})` : ""}`,
        provider: e.provider,
        model: e.model,
        scope: {
          label: e.scope.label,
          files: e.scope.files.length,
          skipped: e.scope.skipped.length,
        },
        log: log(
          "scope",
          `${e.scope.label}: ${e.scope.files.length} files, ${e.scope.skipped.length} skipped`,
          "lav",
        ),
      };
    case "rules":
      return {
        ...p,
        rules: {
          attached: e.attached.map((r) => (r.section ? `${r.path} §${r.section}` : r.path)),
          listed: e.listed.length,
          conflicts: e.conflicts.length,
        },
        log: log(
          "rules",
          `${e.attached.length} attached, ${e.listed.length} listed only${e.conflicts.length ? `, ${e.conflicts.length} conflict(s)` : ""}`,
          "lav",
        ),
      };
    case "cache":
      return {
        ...p,
        cache: { files: e.files, findings: e.findings },
        log: log("cache", `${e.files} files unchanged, ${e.findings} findings reused`, "mint"),
      };
    case "plan":
      for (const s of e.shards) shards.set(s.id, { shard: s, status: "queued", findings: 0 });
      return {
        ...p,
        shards,
        header: `${p.header ?? ""} · ${e.shards.length} shard${e.shards.length === 1 ? "" : "s"}`,
        log: log(
          "plan",
          `${e.shards.length} run${e.shards.length === 1 ? "" : "s"}, est. ${Math.round(e.estimateMs / 60_000) || "<1"} min`,
          "lav",
        ),
      };
    case "shard-started": {
      const s = shards.get(e.shardId);
      if (s) shards.set(e.shardId, { ...s, status: "running" });
      return { ...p, shards, log: log(name(e.shardId), "started", "orange") };
    }
    case "shard-progress": {
      const s = shards.get(e.shardId);
      if (s) shards.set(e.shardId, { ...s, text: e.text });
      const last = p.log.at(-1);
      return last?.tag === name(e.shardId) && last.text === e.text
        ? { ...p, shards }
        : { ...p, shards, log: log(name(e.shardId), e.text) };
    }
    case "finding": {
      const f = e.finding;
      const s = f.shardId ? shards.get(f.shardId) : undefined;
      if (s && f.shardId) shards.set(f.shardId, { ...s, findings: s.findings + 1 });
      return {
        ...p,
        shards,
        findings: p.findings + 1,
        log: log("FIND", `${SEV_LABEL[f.severity]} ${f.file}:${f.range.start}  ${f.title}`, "dim"),
      };
    }
    case "shard-done": {
      const s = shards.get(e.shard.id);
      if (s)
        shards.set(e.shard.id, {
          ...s,
          status: e.shard.status,
          ...(e.shard.durationMs ? { durationMs: e.shard.durationMs } : {}),
          ...(e.shard.error ? { text: e.shard.error } : {}),
        });
      return {
        ...p,
        shards,
        log: log(
          e.shard.label,
          e.shard.status === "failed"
            ? `failed: ${e.shard.error ?? ""}`
            : e.shard.status === "cancelled"
              ? "stopped"
              : `done, ${s?.findings ?? 0} findings`,
          e.shard.status === "failed" ? "red" : "mint",
        ),
      };
    }
    case "usage":
      return { ...p, tokens: { spent: e.spent, budget: e.budget } };
    case "verify-started":
      return {
        ...p,
        verifying: e.count,
        log: log("skeptic", `checking ${e.count} findings`, "lav"),
      };
    case "verified":
      return { ...p, verified: p.verified + 1 };
    case "warning":
      return { ...p, warnings: [...p.warnings, e.message], log: log("warn", e.message, "yellow") };
    case "budget-exceeded":
      return {
        ...p,
        budget: { required: e.required, limit: e.limit },
        log: log("budget", `${e.required} runs exceed the ${e.limit}-run limit`, "red"),
      };
    case "budget-stop":
      return {
        ...p,
        log: log(
          "budget",
          `token budget reached (${formatTokens(e.spent)} of ${formatTokens(e.limit)})`,
          "red",
        ),
      };
    case "rate-limited":
      return {
        ...p,
        rateLimited: true,
        log: log(
          "limit",
          `rate limited; waiting ${Math.round((e.retryAfterMs ?? 0) / 1000)}s`,
          "yellow",
        ),
      };
    case "review-done":
      return {
        ...p,
        done: true,
        ...(e.partial ? { partial: e.partial } : {}),
        log: log(
          "done",
          e.partial ? "stopped early" : `${e.findings.length} findings`,
          e.partial ? "yellow" : "mint",
        ),
      };
    case "review-failed":
      return { ...p, done: true, failed: e.error, log: log("failed", e.error, "red") };
    default:
      return p;
  }
}

/** What the user has chosen on the run screen but not yet run. */
export type Selection = {
  provider?: string;
  model?: string | null;
  effort?: string | null;
  depth?: string;
};
