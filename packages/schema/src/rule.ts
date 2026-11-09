import { z } from "zod";
import { Category, Severity } from "./finding.ts";

export const RuleLayer = z.enum(["user", "project", "global"]);
export type RuleLayer = z.infer<typeof RuleLayer>;

export const RULE_LAYER_PRECEDENCE: Record<RuleLayer, number> = { user: 3, project: 2, global: 1 };

export const RuleSourceKind = z.enum([
  "claude-md",
  "agents-md",
  "cursor-rule",
  "cursorrules",
  "skill",
  "claude-agent",
  "copilot-instructions",
  "review-md",
  "crit-rule",
]);
export type RuleSourceKind = z.infer<typeof RuleSourceKind>;

export const Rule = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  body: z.string(),
  layer: RuleLayer,
  kind: RuleSourceKind,
  path: z.string(),
  section: z.string().optional(),
  globs: z.array(z.string()).default([]),
  scopeDir: z.string().default(""),
  alwaysApply: z.boolean().default(false),
  lens: Category.optional(),
  severity: Severity.optional(),
  description: z.string().optional(),
  reviewRelevant: z.boolean().default(true),
  hash: z.string(),
});
export type Rule = z.infer<typeof Rule>;
export type RuleInput = z.input<typeof Rule>;

export const CritRuleFrontmatter = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  globs: z.union([z.string(), z.array(z.string())]).optional(),
  lens: Category.optional(),
  severity: Severity.optional(),
  alwaysApply: z.boolean().optional(),
});
export type CritRuleFrontmatter = z.infer<typeof CritRuleFrontmatter>;
