import { type Finding, type Fix, newId, type Review, type Shard } from "@crit/schema";

let clock = Date.UTC(2026, 10, 1, 12);
export const tick = (ms = 1000) => (clock += ms);

export function review(repoId: string, over: Partial<Review> = {}): Review {
  return {
    id: newId(),
    repoId,
    scope: { kind: "branch", base: "main" },
    scopeLabel: "feature/payments → main",
    branch: "feature/payments",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    provider: "claude",
    model: "opus",
    lenses: ["correctness", "security"],
    status: "completed",
    supersededBy: null,
    summary: null,
    rulesHeader: null,
    startedAt: tick(),
    finishedAt: null,
    ...over,
  };
}

export function shard(reviewId: string, over: Partial<Shard> = {}): Shard {
  return {
    id: newId(),
    reviewId,
    label: "src/api",
    files: ["src/api/payments.ts"],
    lenses: ["correctness"],
    status: "done",
    estimatedTokens: 1200,
    inputTokens: null,
    outputTokens: null,
    durationMs: null,
    agentSessionId: null,
    summary: null,
    error: null,
    ...over,
  };
}

export function finding(reviewId: string, over: Partial<Finding> = {}): Finding {
  return {
    id: newId(),
    reviewId,
    fingerprint: `fp-${Math.random().toString(16).slice(2, 10)}`,
    file: "src/api/payments.ts",
    range: { start: 88, end: 96 },
    anchor: "await provider.refund(order.chargeId, amount);",
    severity: "critical",
    category: "correctness",
    title: "Refund amount not validated",
    explanation: "refund() takes any amount.",
    confidence: 0.92,
    ruleIds: ["R4"],
    status: "open",
    selected: true,
    mergedFrom: [],
    createdAt: tick(),
    ...over,
  };
}

export function fix(findingId: string, over: Partial<Fix> = {}): Fix {
  return {
    id: newId(),
    findingId,
    author: "ai",
    patch: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
    summary: "Validate amount",
    overridden: false,
    active: true,
    createdAt: tick(),
    ...over,
  };
}
