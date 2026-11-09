import { z } from "zod";

export const Severity = z.enum(["critical", "major", "minor", "nit"]);
export type Severity = z.infer<typeof Severity>;

export const SEVERITY_ORDER: readonly Severity[] = Severity.options;

export const Category = z.enum([
  "correctness",
  "security",
  "performance",
  "maintainability",
  "style",
  "test",
]);
export type Category = z.infer<typeof Category>;

export const Lens = Category;
export type Lens = Category;

export const LineRange = z
  .object({
    start: z.number().int().min(1),
    end: z.number().int().min(1),
  })
  .refine((r) => r.end >= r.start, { message: "range.end must be >= range.start" });
export type LineRange = z.infer<typeof LineRange>;

export const ProposedFix = z.object({
  summary: z.string().min(1),
  patch: z.string().min(1),
});
export type ProposedFix = z.infer<typeof ProposedFix>;

export const FindingInput = z.object({
  file: z.string().min(1),
  range: LineRange,
  anchor: z.string().min(1),
  severity: Severity,
  category: Category,
  title: z.string().min(1).max(100),
  explanation: z.string().min(1),
  failureScenario: z.string().optional(),
  confidence: z.number().min(0).max(1),
  ruleIds: z.array(z.string()).default([]),
  fix: ProposedFix.optional(),
});
export type FindingInput = z.infer<typeof FindingInput>;
export type FindingInputRaw = z.input<typeof FindingInput>;

export const FindingsInput = z.object({ findings: z.array(FindingInput).min(1) });
export type FindingsInput = z.infer<typeof FindingsInput>;

export const SkepticVerdict = z.enum(["confirmed", "plausible", "rejected"]);
export type SkepticVerdict = z.infer<typeof SkepticVerdict>;

export const FindingStatus = z.enum(["open", "applied", "dismissed", "fixed", "closed"]);
export type FindingStatus = z.infer<typeof FindingStatus>;

export const DismissReason = z.enum(["false-positive", "wont-fix", "later"]);
export type DismissReason = z.infer<typeof DismissReason>;

export const Finding = FindingInput.omit({ fix: true }).extend({
  id: z.string(),
  reviewId: z.string(),
  shardId: z.string().optional(),
  fingerprint: z.string(),
  verdict: SkepticVerdict.optional(),
  verdictReason: z.string().optional(),
  status: FindingStatus.default("open"),
  dismissReason: DismissReason.optional(),
  selected: z.boolean().default(false),
  mergedFrom: z.array(z.string()).default([]),
  groupId: z.string().optional(),
  createdAt: z.number().int(),
});
export type Finding = z.infer<typeof Finding>;

export const FixAuthor = z.enum(["ai", "user"]);
export type FixAuthor = z.infer<typeof FixAuthor>;

export const EvaluationVerdict = z.enum(["accepted", "concerns", "rejected"]);
export type EvaluationVerdict = z.infer<typeof EvaluationVerdict>;

export const VerifyResult = z.object({
  passed: z.boolean(),
  commands: z.array(
    z.object({
      command: z.string(),
      exitCode: z.number().int(),
      durationMs: z.number().int().min(0),
      output: z.string().default(""),
    }),
  ),
});
export type VerifyResult = z.infer<typeof VerifyResult>;

export const Fix = z.object({
  id: z.string(),
  findingId: z.string(),
  author: FixAuthor,
  patch: z.string(),
  summary: z.string(),
  evaluation: EvaluationVerdict.optional(),
  evaluationReason: z.string().optional(),
  overridden: z.boolean().default(false),
  verify: VerifyResult.optional(),
  active: z.boolean(),
  createdAt: z.number().int(),
});
export type Fix = z.infer<typeof Fix>;

export const MessageRole = z.enum(["user", "ai"]);
export type MessageRole = z.infer<typeof MessageRole>;

export const Message = z.object({
  id: z.string(),
  findingId: z.string(),
  role: MessageRole,
  body: z.string(),
  createdAt: z.number().int(),
});
export type Message = z.infer<typeof Message>;

export const FinishInput = z.object({
  summary: z.string().min(1),
  coverage: z.string().optional(),
});
export type FinishInput = z.infer<typeof FinishInput>;

export const SkepticResult = z.object({
  findingId: z.string(),
  verdict: SkepticVerdict,
  reason: z.string(),
});
export type SkepticResult = z.infer<typeof SkepticResult>;

export const EvaluationResult = z.object({
  verdict: EvaluationVerdict,
  reason: z.string(),
  question: z.string().optional(),
  failingCase: z.string().optional(),
});
export type EvaluationResult = z.infer<typeof EvaluationResult>;
