import { z } from "zod";
import { Category, Severity } from "./finding.ts";

/** Who owns a rule. Precedence: user beats project, project beats global. */
export const RuleLayer = z.enum(["user", "project", "global"]);
export type RuleLayer = z.infer<typeof RuleLayer>;

export const RULE_LAYER_PRECEDENCE: Record<RuleLayer, number> = { user: 3, project: 2, global: 1 };

/** The file format a rule came from. Adapters declare which kinds their agent loads natively. */
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
  /** Short id assigned per review: R1, R2, … */
  id: z.string(),
  /** Stable key, independent of numbering: `<path>#<section>`. */
  key: z.string(),
  title: z.string(),
  body: z.string(),
  layer: RuleLayer,
  kind: RuleSourceKind,
  /** Path of the source file (absolute for global/user, repo-relative for project). */
  path: z.string(),
  /** Heading of the section this rule was split from, if any. */
  section: z.string().optional(),
  /** Globs (repo-relative) the rule applies to; empty means everywhere in its folder. */
  globs: z.array(z.string()).default([]),
  /** Repo-relative folder a nested CLAUDE.md / AGENTS.md applies to ("" = root). */
  scopeDir: z.string().default(""),
  alwaysApply: z.boolean().default(false),
  lens: Category.optional(),
  severity: Severity.optional(),
  /** Skills are listed by name + description; the agent opens the file when relevant. */
  description: z.string().optional(),
  /** Whether this section is about code review (vs commits, PR titles, tool setup). */
  reviewRelevant: z.boolean().default(true),
  /** sha256 of title + body, used for caching and conflict detection. */
  hash: z.string(),
});
export type Rule = z.infer<typeof Rule>;
export type RuleInput = z.input<typeof Rule>;

/** Frontmatter of a `.crit/rules/**.md` file. */
export const CritRuleFrontmatter = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  globs: z.union([z.string(), z.array(z.string())]).optional(),
  lens: Category.optional(),
  severity: Severity.optional(),
  alwaysApply: z.boolean().optional(),
});
export type CritRuleFrontmatter = z.infer<typeof CritRuleFrontmatter>;
