import type { Finding, Fix, Message, Repo, Review, Shard, Suppression } from "@crit/schema";
import type * as t from "./db/schema.ts";

type Row<T extends { $inferSelect: unknown }> = T["$inferSelect"];

const json = <T>(s: string | null): T | undefined =>
  s === null ? undefined : (JSON.parse(s) as T);
const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

export const repoFromRow = (r: Row<typeof t.repos>): Repo => ({
  id: r.id,
  root: r.rootPath,
  remoteUrl: r.remoteUrl,
  name: r.name,
});

export const reviewToRow = (r: Review): Row<typeof t.reviews> => ({
  id: r.id,
  repoId: r.repoId,
  scope: JSON.stringify(r.scope),
  scopeKind: r.scope.kind,
  scopeLabel: r.scopeLabel,
  branch: r.branch,
  baseSha: r.baseSha,
  headSha: r.headSha,
  provider: r.provider,
  model: r.model,
  lenses: JSON.stringify(r.lenses),
  status: r.status,
  supersededBy: r.supersededBy,
  summary: r.summary,
  rulesHeader: r.rulesHeader,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
});

export const reviewFromRow = (r: Row<typeof t.reviews>): Review => ({
  id: r.id,
  repoId: r.repoId,
  scope: JSON.parse(r.scope),
  scopeLabel: r.scopeLabel,
  branch: r.branch,
  baseSha: r.baseSha,
  headSha: r.headSha,
  provider: r.provider,
  model: r.model,
  lenses: JSON.parse(r.lenses),
  status: r.status as Review["status"],
  supersededBy: r.supersededBy,
  summary: r.summary,
  rulesHeader: r.rulesHeader,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
});

export const shardToRow = (s: Shard): Row<typeof t.shards> => ({
  ...s,
  files: JSON.stringify(s.files),
  lenses: JSON.stringify(s.lenses),
});

export const shardFromRow = (s: Row<typeof t.shards>): Shard => ({
  ...s,
  files: JSON.parse(s.files),
  lenses: JSON.parse(s.lenses),
  status: s.status as Shard["status"],
});

export const findingToRow = (f: Finding): Row<typeof t.findings> => ({
  id: f.id,
  reviewId: f.reviewId,
  shardId: f.shardId ?? null,
  fingerprint: f.fingerprint,
  file: f.file,
  rangeStart: f.range.start,
  rangeEnd: f.range.end,
  anchor: f.anchor,
  severity: f.severity,
  category: f.category,
  title: f.title,
  explanation: f.explanation,
  failureScenario: f.failureScenario ?? null,
  confidence: f.confidence,
  ruleIds: JSON.stringify(f.ruleIds),
  verdict: f.verdict ?? null,
  verdictReason: f.verdictReason ?? null,
  status: f.status,
  dismissReason: f.dismissReason ?? null,
  selected: f.selected,
  mergedFrom: JSON.stringify(f.mergedFrom),
  groupId: f.groupId ?? null,
  createdAt: f.createdAt,
});

export const findingFromRow = (r: Row<typeof t.findings>): Finding => {
  const f: Finding = {
    id: r.id,
    reviewId: r.reviewId,
    fingerprint: r.fingerprint,
    file: r.file,
    range: { start: r.rangeStart, end: r.rangeEnd },
    anchor: r.anchor,
    severity: r.severity as Finding["severity"],
    category: r.category as Finding["category"],
    title: r.title,
    explanation: r.explanation,
    confidence: r.confidence,
    ruleIds: JSON.parse(r.ruleIds),
    status: r.status as Finding["status"],
    selected: r.selected,
    mergedFrom: JSON.parse(r.mergedFrom),
    createdAt: r.createdAt,
  };
  if (r.shardId !== null) f.shardId = r.shardId;
  if (r.failureScenario !== null) f.failureScenario = r.failureScenario;
  if (r.verdict !== null) f.verdict = r.verdict as Finding["verdict"];
  if (r.verdictReason !== null) f.verdictReason = r.verdictReason;
  if (r.dismissReason !== null) f.dismissReason = r.dismissReason as Finding["dismissReason"];
  if (r.groupId !== null) f.groupId = r.groupId;
  return f;
};

export const fixToRow = (f: Fix): Row<typeof t.fixes> => ({
  id: f.id,
  findingId: f.findingId,
  author: f.author,
  patch: f.patch,
  summary: f.summary,
  evaluation: f.evaluation ?? null,
  evaluationReason: f.evaluationReason ?? null,
  overridden: f.overridden,
  verify: f.verify ? JSON.stringify(f.verify) : null,
  active: f.active,
  createdAt: f.createdAt,
});

export const fixFromRow = (r: Row<typeof t.fixes>): Fix => {
  const f: Fix = {
    id: r.id,
    findingId: r.findingId,
    author: r.author as Fix["author"],
    patch: r.patch,
    summary: r.summary,
    overridden: r.overridden,
    active: r.active,
    createdAt: r.createdAt,
  };
  const evaluation = opt(r.evaluation);
  if (evaluation) f.evaluation = evaluation as Fix["evaluation"];
  const reason = opt(r.evaluationReason);
  if (reason !== undefined) f.evaluationReason = reason;
  const verify = json<Fix["verify"]>(r.verify);
  if (verify) f.verify = verify;
  return f;
};

export const messageFromRow = (r: Row<typeof t.messages>): Message => ({
  ...r,
  role: r.role as Message["role"],
});

export const suppressionFromRow = (r: Row<typeof t.suppressions>): Suppression => ({
  ...r,
  reason: r.reason as Suppression["reason"],
});
