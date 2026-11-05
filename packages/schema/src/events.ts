import type { Finding, SkepticResult } from "./finding.ts";
import type { ResolvedScope, Shard } from "./review.ts";
import type { Rule } from "./rule.ts";

/**
 * Events emitted by core while a review runs. Shells (CLI, TUI, future web)
 * render these; core never prints or prompts.
 */
export type ReviewEvent =
  | {
      type: "review-started";
      reviewId: string;
      scope: ResolvedScope;
      provider: string;
      model: string | null;
    }
  | {
      type: "rules";
      attached: Pick<Rule, "id" | "title" | "path" | "section">[];
      listed: Pick<Rule, "id" | "title" | "path">[];
      conflicts: { topic: string; ruleIds: string[] }[];
    }
  | { type: "plan"; shards: Shard[]; estimateMs: number }
  | { type: "shard-started"; shardId: string }
  | { type: "shard-progress"; shardId: string; text: string }
  | { type: "finding"; finding: Finding }
  | { type: "finding-rejected"; shardId: string; errors: string[] }
  | { type: "shard-done"; shard: Shard }
  | { type: "rate-limited"; shardId: string; retryAfterMs?: number }
  | { type: "budget-exceeded"; required: number; limit: number }
  | { type: "verify-started"; count: number }
  | { type: "verified"; result: SkepticResult }
  | { type: "warning"; message: string }
  | { type: "review-done"; reviewId: string; findings: Finding[]; durationMs: number }
  | { type: "review-failed"; reviewId: string; error: string };

export type ReviewEventListener = (event: ReviewEvent) => void;
