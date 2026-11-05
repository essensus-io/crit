/**
 * SQLite tables. Portability rules (so a Postgres schema is a mechanical copy):
 * - ids are UUIDv7 text made in code, never auto-increment
 * - timestamps are integer milliseconds
 * - JSON is stored as text
 * - no SQLite-only SQL in queries
 */
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const repos = sqliteTable(
  "repos",
  {
    id: text("id").primaryKey(),
    rootPath: text("root_path").notNull(),
    remoteUrl: text("remote_url"),
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("repos_root_path_idx").on(t.rootPath)],
);

export const reviews = sqliteTable(
  "reviews",
  {
    id: text("id").primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    /** ScopeSpec JSON */
    scope: text("scope").notNull(),
    scopeKind: text("scope_kind").notNull(),
    scopeLabel: text("scope_label").notNull(),
    branch: text("branch"),
    baseSha: text("base_sha"),
    headSha: text("head_sha"),
    provider: text("provider").notNull(),
    model: text("model"),
    /** Lens[] JSON */
    lenses: text("lenses").notNull(),
    status: text("status").notNull(),
    supersededBy: text("superseded_by"),
    summary: text("summary"),
    rulesHeader: text("rules_header"),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    index("reviews_repo_started_idx").on(t.repoId, t.startedAt),
    index("reviews_branch_idx").on(t.repoId, t.branch),
  ],
);

export const shards = sqliteTable(
  "shards",
  {
    id: text("id").primaryKey(),
    reviewId: text("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    /** string[] JSON */
    files: text("files").notNull(),
    lenses: text("lenses").notNull(),
    status: text("status").notNull(),
    estimatedTokens: integer("estimated_tokens").notNull(),
    inputTokens: integer("input_tokens"),
    cachedTokens: integer("cached_tokens"),
    outputTokens: integer("output_tokens"),
    durationMs: integer("duration_ms"),
    agentSessionId: text("agent_session_id"),
    summary: text("summary"),
    error: text("error"),
  },
  (t) => [index("shards_review_idx").on(t.reviewId)],
);

export const findings = sqliteTable(
  "findings",
  {
    id: text("id").primaryKey(),
    reviewId: text("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    shardId: text("shard_id"),
    fingerprint: text("fingerprint").notNull(),
    file: text("file").notNull(),
    rangeStart: integer("range_start").notNull(),
    rangeEnd: integer("range_end").notNull(),
    anchor: text("anchor").notNull(),
    severity: text("severity").notNull(),
    category: text("category").notNull(),
    title: text("title").notNull(),
    explanation: text("explanation").notNull(),
    failureScenario: text("failure_scenario"),
    confidence: real("confidence").notNull(),
    ruleIds: text("rule_ids").notNull(),
    verdict: text("verdict"),
    verdictReason: text("verdict_reason"),
    status: text("status").notNull(),
    dismissReason: text("dismiss_reason"),
    selected: integer("selected", { mode: "boolean" }).notNull(),
    mergedFrom: text("merged_from").notNull(),
    groupId: text("group_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("findings_review_idx").on(t.reviewId),
    index("findings_fingerprint_idx").on(t.fingerprint),
  ],
);

export const fixes = sqliteTable(
  "fixes",
  {
    id: text("id").primaryKey(),
    findingId: text("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    author: text("author").notNull(),
    patch: text("patch").notNull(),
    summary: text("summary").notNull(),
    evaluation: text("evaluation"),
    evaluationReason: text("evaluation_reason"),
    overridden: integer("overridden", { mode: "boolean" }).notNull(),
    /** VerifyResult JSON */
    verify: text("verify"),
    active: integer("active", { mode: "boolean" }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("fixes_finding_idx").on(t.findingId)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    findingId: text("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    body: text("body").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("messages_finding_idx").on(t.findingId)],
);

export const suppressions = sqliteTable(
  "suppressions",
  {
    id: text("id").primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    reason: text("reason").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("suppressions_repo_fp_idx").on(t.repoId, t.fingerprint)],
);

export const cacheEntries = sqliteTable(
  "cache_entries",
  {
    /** hash of (content hash, rules hash, lens, provider, model) */
    key: text("key").primaryKey(),
    reviewId: text("review_id").references(() => reviews.id, { onDelete: "set null" }),
    /** Cached FindingInput[] JSON plus shard summary */
    value: text("value").notNull(),
    transcriptPath: text("transcript_path"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("cache_entries_created_idx").on(t.createdAt)],
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    reviewId: text("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: text("payload").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("events_review_idx").on(t.reviewId, t.createdAt)],
);

/** Small derived caches: rule section tags by content hash, repo map summaries by commit. */
export const kv = sqliteTable("kv", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  createdAt: integer("created_at").notNull(),
});
