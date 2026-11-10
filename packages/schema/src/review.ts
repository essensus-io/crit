import { z } from "zod";
import { Lens } from "./finding.ts";
import { Finding, Fix, Message } from "./finding.ts";

export const ScopeSpec = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), base: z.string().optional() }),
  z.object({ kind: z.literal("staged") }),
  z.object({ kind: z.literal("ref"), ref: z.string().min(1), base: z.string().optional() }),
  z.object({ kind: z.literal("commit"), sha: z.string().min(1) }),
  z.object({
    kind: z.literal("paths"),
    paths: z.array(z.string()).min(1),
    diff: z.boolean().default(false),
    base: z.string().optional(),
  }),
  z.object({ kind: z.literal("project") }),
]);
export type ScopeSpec = z.infer<typeof ScopeSpec>;

export const Hunk = z.object({
  start: z.number().int().min(0),
  lines: z.number().int().min(0),
});
export type Hunk = z.infer<typeof Hunk>;

export const ScopedFile = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted", "renamed", "unchanged"]),
  hunks: z.array(Hunk).optional(),
  size: z.number().int().min(0),
  oldPath: z.string().optional(),
});
export type ScopedFile = z.infer<typeof ScopedFile>;

export const ResolvedScope = z.object({
  spec: ScopeSpec,
  label: z.string(),
  root: z.string(),
  baseSha: z.string().optional(),
  headSha: z.string().optional(),
  baseRef: z.string().optional(),
  branch: z.string().optional(),
  files: z.array(ScopedFile),
  diff: z.string().optional(),
  ignored: z.array(z.string()).default([]),
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })).default([]),
});
export type ResolvedScope = z.infer<typeof ResolvedScope>;

export const ReviewStatus = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "superseded",
  "partial",
]);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

export const Repo = z.object({
  id: z.string(),
  root: z.string(),
  remoteUrl: z.string().nullable(),
  name: z.string(),
});
export type Repo = z.infer<typeof Repo>;

export const Review = z.object({
  id: z.string(),
  repoId: z.string(),
  scope: ScopeSpec,
  scopeLabel: z.string(),
  branch: z.string().nullable().default(null),
  baseSha: z.string().nullable().default(null),
  headSha: z.string().nullable().default(null),
  provider: z.string(),
  model: z.string().nullable().default(null),
  lenses: z.array(Lens),
  status: ReviewStatus,
  supersededBy: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
  rulesHeader: z.string().nullable().default(null),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable().default(null),
});
export type Review = z.infer<typeof Review>;

export const ShardStatus = z.enum(["queued", "running", "done", "failed", "cached", "cancelled"]);
export type ShardStatus = z.infer<typeof ShardStatus>;

export const Shard = z.object({
  id: z.string(),
  reviewId: z.string(),
  label: z.string(),
  files: z.array(z.string()),
  lenses: z.array(Lens),
  status: ShardStatus,
  estimatedTokens: z.number().int().min(0),
  inputTokens: z.number().int().nullable().default(null),
  cachedTokens: z.number().int().nullable().default(null),
  outputTokens: z.number().int().nullable().default(null),
  durationMs: z.number().int().nullable().default(null),
  agentSessionId: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type Shard = z.infer<typeof Shard>;

export const Suppression = z.object({
  id: z.string(),
  repoId: z.string(),
  fingerprint: z.string(),
  reason: z.enum(["false-positive", "wont-fix"]),
  createdAt: z.number().int(),
});
export type Suppression = z.infer<typeof Suppression>;

export const REVIEW_EXPORT_VERSION = 1;

export const ReviewExport = z.object({
  format: z.literal("crit.review"),
  version: z.literal(REVIEW_EXPORT_VERSION),
  exportedAt: z.number().int(),
  repo: Repo,
  review: Review,
  shards: z.array(Shard),
  findings: z.array(Finding),
  fixes: z.array(Fix),
  messages: z.array(Message),
});
export type ReviewExport = z.infer<typeof ReviewExport>;
