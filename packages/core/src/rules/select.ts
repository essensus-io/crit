import { RULE_LAYER_PRECEDENCE, Rule, type RuleLayer, type RuleSourceKind } from "@crit/schema";
import picomatch from "picomatch";
import { type ParsedRule, parseRuleFile, type RuleFile } from "./parse.ts";

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

const NON_REVIEW_TITLE =
  /\b(commit(s| messages?)?|pr titles?|pull requests?|branch(es| naming)?|changelog|releases?|releasing|versioning|install(ation|ing)?|setup|set up|getting started|quick ?start|dev(elopment)? (server|environment)|running( the)? (app|tests|locally)|how to run|scripts|commands|deploy(ment|ing)?|ci( ?\/ ?cd)?|tool(s|ing)|editor|ide|workflow|git( usage)?|contributing|license|contact|links|table of contents|toc)\b/i;

export function isReviewRelevant(r: Pick<ParsedRule, "title" | "body" | "kind">): boolean {
  if (r.kind === "crit-rule" || r.kind === "cursor-rule" || r.kind === "review-md") return true;
  if (r.kind === "skill" || r.kind === "claude-agent") return true;
  if (NON_REVIEW_TITLE.test(r.title) && !/\b(code|review|style|error|security)\b/i.test(r.title))
    return false;
  const prose = r.body.replace(/```[\s\S]*?```/g, "").trim();
  return prose.length > 0 || !/```/.test(r.body);
}

export type RuleTagger = (
  sections: { hash: string; title: string; body: string }[],
) => Promise<Map<string, boolean>>;
export type TagCache = {
  get(hash: string): Promise<boolean | undefined>;
  set(hash: string, relevant: boolean): Promise<void>;
};

export type LoadRulesOptions = {
  files: RuleFile[];
  scopeFiles: string[];
  nativeKinds?: RuleSourceKind[];
  sources?: RuleLayer[];
  exclude?: string[];
  disabled?: string[];
  budgetTokens?: number;
  tagger?: RuleTagger;
  tagCache?: TagCache;
};

export type RuleConflict = { topic: string; ruleIds: string[]; winner: string };

export type RuleSet = {
  all: Rule[];
  attached: Rule[];
  listed: Rule[];
  skills: Rule[];
  native: Rule[];
  filtered: Rule[];
  conflicts: RuleConflict[];
  unattached: Rule[];
  errors: string[];
};

const topicOf = (title: string) =>
  title
    .toLowerCase()
    .replace(/\(intro\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

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

  const byTopic = new Map<string, Rule[]>();
  for (const r of applicable) {
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

export function ruleLabel(r: Pick<Rule, "kind" | "path" | "section" | "title">): string {
  if (r.kind === "skill") return `skill ${r.title}`;
  if (r.kind === "claude-agent") return `agent ${r.title}`;
  return r.section ? `${r.path} §${r.section}` : r.path;
}
