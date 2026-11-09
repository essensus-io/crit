import { newId, type Shard } from "@crit/schema";
import type { Prepared } from "./review-types.ts";

export const planShards = (prepared: Prepared, reviewId: string, now: () => number): Shard[] =>
  prepared.runs.map((planned) => ({
    id: newId(now()),
    reviewId,
    label: planned.label,
    files: planned.files,
    lenses: planned.lenses,
    status: "queued" as const,
    estimatedTokens: planned.estimatedTokens,
    inputTokens: null,
    cachedTokens: null,
    outputTokens: null,
    durationMs: null,
    agentSessionId: null,
    summary: null,
    error: null,
  }));
