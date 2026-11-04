import { RULE_LAYER_PRECEDENCE, Rule, type RuleLayer, type RuleSourceKind } from "@crit/schema";
import picomatch from "picomatch";
import { type ParsedRule, parseRuleFile, type RuleFile } from "./parse.ts";

/** Rough token estimate: 4 characters per token. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

const NON_REVIEW_TITLE =
  /\b(commit(s| messages?)?|pr titles?|pull requests?|branch(es| naming)?|changelog|releases?|releasing|versioning|install(ation|ing)?|setup|set up|getting started|quick ?start|dev(elopment)? (server|environment)|running( the)? (app|tests|locally)|how to run|scripts|commands|deploy(ment|ing)?|ci( ?\/ ?cd)?|tool(s|ing)|editor|ide|workflow|git( usage)?|contributing|license|contact|links|table of contents|toc)\b/i;

/**
 * Heuristic: is this section about how code should be written (a review rule)
 * rather than commits, PR titles, setup or tooling?
 */
export function isReviewRelevant(r: Pick<ParsedRule, "title" | "body" | "kind">): boolean {
  if (r.kind === "crit-rule" || r.kind === "cursor-rule" || r.kind === "review-md") return true;
  if (r.kind === "skill" || r.kind === "claude-agent") return true;
  if (NON_REVIEW_TITLE.test(r.title) && !/\b(code|review|style|error|security)\b/i.test(r.title))
    return false;
  // Sections that are only shell commands are setup notes.
  const prose = r.body.replace(/```[\s\S]*?```/g, "").trim();
  return prose.length > 0 || !/```/.test(r.body);
}

/** Optional one-time model pass that tags sections; results are cached by content hash. */
export type RuleTagger = (
  sections: { hash: string; title: string; body: string }[],
) => Promise<Map<string, boolean>>;
export type TagCache = {
  get(hash: string): Promise<boolean | undefined>;
  set(hash: string, relevant: boolean): Promise<void>;
};

export type LoadRulesOptions = {
  files: RuleFile[];
  /** Repo-relative files in scope; rules with globs or a folder attach only when one matches. */
  scopeFiles: string[];
  /** Kinds the agent loads by itself: those rules are sent as an index only. */
  nativeKinds?: RuleSourceKind[];
  sources?: RuleLayer[];
  /** `path` or `path#Section` */
  exclude?: string[];
  /** Rule keys turned off by the user in the review screen. */
  disabled?: string[];
  budgetTokens?: number;
  tagger?: RuleTagger;
  tagCache?: TagCache;
};

export type RuleConflict = { topic: string; ruleIds: string[]; winner: string };

export type RuleSet = {
  /** Every review-relevant rule with an id (R1, R2, …). */
  all: Rule[];
  /** Inlined into the prompt. */
  attached: Rule[];
  /** Sent as id + title + path; the agent reads them with get_rules when needed. */
  listed: Rule[];
  /** Skills and agents: name + description only. */
  skills: Rule[];
  /** Attached but loaded natively by the agent: index only. */
  native: Rule[];
  /** Sections tagged as not about review. */
  filtered: Rule[];
  /** Same topic in more than one layer; the winner is kept. */
  conflicts: RuleConflict[];
  /** Rules that do not apply to any file in scope. */
  unattached: Rule[];
  errors: string[];
};

const topicOf = (title: string) =>
  title
    .toLowerCase()
    .replace(/\(intro\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Does a rule apply to any of the given files? */
export function ruleApplies(
  rule: Pick<Rule, "globs" | "scopeDir" | "alwaysApply">,
  files: string[],
): boolean {
  if (rule.alwaysApply) return true;
  const inDir = rule.scopeDir
    ? files.filter((f) => f === rule.scopeDir || f.startsWith(`${rule.scopeDir}/`))
    : files;
  if (inDir.length === 0) return false;
  if (rule.globs.length === 0) return true;
  const positive = rule.globs.filter((g) => !g.startsWith("!"));
  const negative = rule.globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
  const yes = positive.length ? picomatch(positive, { dot: true }) : () => true;
  const no = negative.length ? picomatch(negative, { dot: true }) : () => false;
  return inDir.some((f) => yes(f) && !no(f));
}

function excluded(r: ParsedRule, patterns: string[]): boolean {
  return patterns.some((p) => {
    const [path, section] = p.split("#");
    const pathMatch =
      r.path === path || r.path.endsWith(`/${path}`) || picomatch(path!, { dot: true })(r.path);
    if (!pathMatch) return false;
    return (
      section === undefined ||
      r.section?.toLowerCase() === section.toLowerCase() ||
      r.title.toLowerCase() === section.toLowerCase()
    );
  });
}

const kindOrder: RuleSourceKind[] = [
  "crit-rule",
  "review-md",
  "cursor-rule",
  "cursorrules",
  "claude-md",
  "agents-md",
  "copilot-instructions",
  "claude-agent",
  "skill",
];

/**
 * Turn rule files into one numbered rule set for a review: parse, filter for
 * review, attach by scope, resolve conflicts (user > project > global), and
 * fit the inline budget.
 */
export async function loadRules(opts: LoadRulesOptions): Promise<RuleSet> {
  const sources = new Set(opts.sources ?? ["project", "global", "user"]);
  const disabled = new Set(opts.disabled ?? []);
  const native = new Set(opts.nativeKinds ?? []);
  const errors: string[] = [];

  let parsed: ParsedRule[] = [];
  for (const file of opts.files) {
    if (!sources.has(file.layer)) continue;
    try {
      parsed.push(...parseRuleFile(file));
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  parsed = parsed.filter((r) => !excluded(r, opts.exclude ?? []) && !disabled.has(r.key));

  // Review filter: heuristic first, then an optional cached model pass for markdown sections.
  const relevance = new Map<string, boolean>(parsed.map((r) => [r.hash, isReviewRelevant(r)]));
  if (opts.tagger) {
    const candidates = parsed.filter((r) =>
      ["claude-md", "agents-md", "copilot-instructions", "cursorrules"].includes(r.kind),
    );
    const pending: ParsedRule[] = [];
    for (const r of candidates) {
      const cached = await opts.tagCache?.get(r.hash);
      if (cached === undefined) pending.push(r);
      else relevance.set(r.hash, cached);
    }
    if (pending.length) {
      try {
        const tags = await opts.tagger(
          pending.map(({ hash, title, body }) => ({ hash, title, body })),
        );
        for (const [hash, rel] of tags) {
          relevance.set(hash, rel);
          await opts.tagCache?.set(hash, rel);
        }
      } catch (err) {
        errors.push(`rule tagging failed, using heuristic: ${(err as Error).message}`);
      }
    }
  }

  // Stable numbering: layer precedence, then kind, then path, then section order.
  const ordered = parsed
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) =>
        RULE_LAYER_PRECEDENCE[b.r.layer] - RULE_LAYER_PRECEDENCE[a.r.layer] ||
        kindOrder.indexOf(a.r.kind) - kindOrder.indexOf(b.r.kind) ||
        a.r.path.localeCompare(b.r.path) ||
        a.i - b.i,
    )
    .map(({ r }) => r);

  const all: Rule[] = [];
  const filtered: Rule[] = [];
  let n = 0;
  for (const p of ordered) {
    const rule = Rule.parse({ ...p, id: "", reviewRelevant: relevance.get(p.hash) ?? true });
    if (!rule.reviewRelevant) {
      filtered.push({ ...rule, id: "-" });
      continue;
    }
    rule.id = `R${++n}`;
    all.push(rule);
  }

  const skills = all.filter((r) => r.kind === "skill" || r.kind === "claude-agent");
  const regular = all.filter((r) => r.kind !== "skill" && r.kind !== "claude-agent");
  const applicable: Rule[] = [];
  const unattached: Rule[] = [];
  for (const r of regular) (ruleApplies(r, opts.scopeFiles) ? applicable : unattached).push(r);

  // Conflicts: the same topic in more than one layer. Higher layer wins; deeper folder wins within a layer.
  const byTopic = new Map<string, Rule[]>();
  for (const r of applicable) {
    // Titles derived from a file name ("AGENTS.md", "CLAUDE.md (intro)") are not topics.
    const file = r.path.split("/").pop()!;
    const derived =
      r.title === file || r.title === file.replace(/\.mdc?$/, "") || r.title.endsWith("(intro)");
    const topic = topicOf(r.section ?? (derived ? "" : r.title));
    if (!topic) continue;
    byTopic.set(topic, [...(byTopic.get(topic) ?? []), r]);
  }
  const conflicts: RuleConflict[] = [];
  const losers = new Set<string>();
  for (const [topic, rules] of byTopic) {
    const layers = new Set(rules.map((r) => r.layer));
    if (rules.length < 2 || layers.size < 2) continue;
    const winner = [...rules].sort(
      (a, b) =>
        RULE_LAYER_PRECEDENCE[b.layer] - RULE_LAYER_PRECEDENCE[a.layer] ||
        b.scopeDir.length - a.scopeDir.length,
    )[0]!;
    for (const r of rules) if (r !== winner) losers.add(r.id);
    conflicts.push({ topic, ruleIds: rules.map((r) => r.id), winner: winner.id });
  }

  const kept = applicable.filter((r) => !losers.has(r.id));
  const nativeRules = kept.filter((r) => native.has(r.kind));
  const toInline = kept
    .filter((r) => !native.has(r.kind))
    // Specific rules first: always-apply, then glob/folder-scoped, then general; within that, precedence.
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const spec = (r: Rule) => (r.alwaysApply ? 0 : r.globs.length || r.scopeDir ? 1 : 2);
      return spec(a.r) - spec(b.r) || a.i - b.i;
    })
    .map(({ r }) => r);

  const budget = opts.budgetTokens ?? 8000;
  let used = 0;
  const attached: Rule[] = [];
  const listed: Rule[] = [];
  for (const r of toInline) {
    const cost = estimateTokens(r.title + r.body) + 8;
    if (used + cost <= budget) {
      attached.push(r);
      used += cost;
    } else listed.push(r);
  }
  const byId = (a: Rule, b: Rule) => Number(a.id.slice(1)) - Number(b.id.slice(1));
  attached.sort(byId);
  listed.sort(byId);

  return {
    all,
    attached,
    listed,
    skills,
    native: nativeRules,
    filtered,
    conflicts,
    unattached,
    errors,
  };
}

/** Short label for a rule in headers: "CLAUDE.md §Errors", ".cursor/rules/payments.mdc", "skill api-design". */
export function ruleLabel(r: Pick<Rule, "kind" | "path" | "section" | "title">): string {
  if (r.kind === "skill") return `skill ${r.title}`;
  if (r.kind === "claude-agent") return `agent ${r.title}`;
  return r.section ? `${r.path} §${r.section}` : r.path;
}
