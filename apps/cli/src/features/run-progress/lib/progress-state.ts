import { formatTokens, type ReviewEvent, type Shard } from "@crit/schema";
import { SEV_LABEL, type Tone } from "@/shared/lib/theme.ts";

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
  | { kind: "home" }
  | { kind: "budget"; maxShards: number }
  | {
      kind: "retry";
      provider?: string;
      model?: string | null;
      effort?: string | null;
      depth?: string;
      fresh?: boolean;
    };

export const emptyProgress = (): ProgressState => ({
  shards: new Map(),
  findings: 0,
  verified: 0,
  log: [],
  warnings: [],
});

export function reduceProgress(
  progressState: ProgressState,
  reviewEvent: ReviewEvent,
  now = Date.now(),
): ProgressState {
  const shards = new Map(progressState.shards);
  const log = (tag: string, text: string, tone: LogEntry["tone"] = "dim"): LogEntry[] =>
    [...progressState.log, { at: now, tag, text, tone }].slice(-MAX_LOG);
  const name = (id: string) => progressState.shards.get(id)?.shard.label ?? id;
  switch (reviewEvent.type) {
    case "review-started":
      return {
        ...progressState,
        startedAt: progressState.startedAt ?? now,
        header: `${reviewEvent.scope.label} · ${reviewEvent.provider}${reviewEvent.model ? ` (${reviewEvent.model})` : ""}`,
        provider: reviewEvent.provider,
        model: reviewEvent.model,
        scope: {
          label: reviewEvent.scope.label,
          files: reviewEvent.scope.files.length,
          skipped: reviewEvent.scope.skipped.length,
        },
        log: log(
          "scope",
          `${reviewEvent.scope.label}: ${reviewEvent.scope.files.length} files, ${reviewEvent.scope.skipped.length} skipped`,
          "lav",
        ),
      };
    case "rules":
      return {
        ...progressState,
        rules: {
          attached: reviewEvent.attached.map((r) =>
            r.section ? `${r.path} §${r.section}` : r.path,
          ),
          listed: reviewEvent.listed.length,
          conflicts: reviewEvent.conflicts.length,
        },
        log: log(
          "rules",
          `${reviewEvent.attached.length} attached, ${reviewEvent.listed.length} listed only${reviewEvent.conflicts.length ? `, ${reviewEvent.conflicts.length} conflict(s)` : ""}`,
          "lav",
        ),
      };
    case "cache":
      return {
        ...progressState,
        cache: { files: reviewEvent.files, findings: reviewEvent.findings },
        log: log(
          "cache",
          `${reviewEvent.files} files unchanged, ${reviewEvent.findings} findings reused`,
          "mint",
        ),
      };
    case "plan":
      for (const shard of reviewEvent.shards)
        shards.set(shard.id, { shard: shard, status: "queued", findings: 0 });
      return {
        ...progressState,
        shards,
        header: `${progressState.header ?? ""} · ${reviewEvent.shards.length} shard${reviewEvent.shards.length === 1 ? "" : "s"}`,
        log: log(
          "plan",
          `${reviewEvent.shards.length} run${reviewEvent.shards.length === 1 ? "" : "s"}, est. ${Math.round(reviewEvent.estimateMs / 60_000) || "<1"} min`,
          "lav",
        ),
      };
    case "shard-started": {
      const s = shards.get(reviewEvent.shardId);
      if (s) shards.set(reviewEvent.shardId, { ...s, status: "running" });
      return { ...progressState, shards, log: log(name(reviewEvent.shardId), "started", "orange") };
    }
    case "shard-progress": {
      const s = shards.get(reviewEvent.shardId);
      if (s) shards.set(reviewEvent.shardId, { ...s, text: reviewEvent.text });
      const last = progressState.log.at(-1);
      return last?.tag === name(reviewEvent.shardId) && last.text === reviewEvent.text
        ? { ...progressState, shards }
        : { ...progressState, shards, log: log(name(reviewEvent.shardId), reviewEvent.text) };
    }
    case "finding": {
      const f = reviewEvent.finding;
      const s = f.shardId ? shards.get(f.shardId) : undefined;
      if (s && f.shardId) shards.set(f.shardId, { ...s, findings: s.findings + 1 });
      return {
        ...progressState,
        shards,
        findings: progressState.findings + 1,
        log: log("FIND", `${SEV_LABEL[f.severity]} ${f.file}:${f.range.start}  ${f.title}`, "dim"),
      };
    }
    case "shard-done": {
      const s = shards.get(reviewEvent.shard.id);
      if (s)
        shards.set(reviewEvent.shard.id, {
          ...s,
          status: reviewEvent.shard.status,
          ...(reviewEvent.shard.durationMs ? { durationMs: reviewEvent.shard.durationMs } : {}),
          ...(reviewEvent.shard.error ? { text: reviewEvent.shard.error } : {}),
        });
      return {
        ...progressState,
        shards,
        log: log(
          reviewEvent.shard.label,
          reviewEvent.shard.status === "failed"
            ? `failed: ${reviewEvent.shard.error ?? ""}`
            : reviewEvent.shard.status === "cancelled"
              ? "stopped"
              : `done, ${s?.findings ?? 0} findings`,
          reviewEvent.shard.status === "failed" ? "red" : "mint",
        ),
      };
    }
    case "usage":
      return { ...progressState, tokens: { spent: reviewEvent.spent, budget: reviewEvent.budget } };
    case "verify-started":
      return {
        ...progressState,
        verifying: reviewEvent.count,
        log: log("skeptic", `checking ${reviewEvent.count} findings`, "lav"),
      };
    case "verified":
      return { ...progressState, verified: progressState.verified + 1 };
    case "warning":
      return {
        ...progressState,
        warnings: [...progressState.warnings, reviewEvent.message],
        log: log("warn", reviewEvent.message, "yellow"),
      };
    case "budget-exceeded":
      return {
        ...progressState,
        budget: { required: reviewEvent.required, limit: reviewEvent.limit },
        log: log(
          "budget",
          `${reviewEvent.required} runs exceed the ${reviewEvent.limit}-run limit`,
          "red",
        ),
      };
    case "budget-stop":
      return {
        ...progressState,
        log: log(
          "budget",
          `token budget reached (${formatTokens(reviewEvent.spent)} of ${formatTokens(reviewEvent.limit)})`,
          "red",
        ),
      };
    case "rate-limited":
      return {
        ...progressState,
        rateLimited: true,
        log: log(
          "limit",
          `rate limited; waiting ${Math.round((reviewEvent.retryAfterMs ?? 0) / 1000)}s`,
          "yellow",
        ),
      };
    case "review-done":
      return {
        ...progressState,
        done: true,
        ...(reviewEvent.partial ? { partial: reviewEvent.partial } : {}),
        log: log(
          "done",
          reviewEvent.partial ? "stopped early" : `${reviewEvent.findings.length} findings`,
          reviewEvent.partial ? "yellow" : "mint",
        ),
      };
    case "review-failed":
      return {
        ...progressState,
        done: true,
        failed: reviewEvent.error,
        log: log("failed", reviewEvent.error, "red"),
      };
    default:
      return progressState;
  }
}

export type Selection = {
  provider?: string;
  model?: string | null;
  effort?: string | null;
  depth?: string;
};
