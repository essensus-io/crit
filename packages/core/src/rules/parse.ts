import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import {
  CritRuleFrontmatter,
  type RuleInput,
  type RuleLayer,
  type RuleSourceKind,
} from "@crit/schema";
import matter from "gray-matter";
import type { Heading, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

export type RuleFile = {
  layer: RuleLayer;
  kind: RuleSourceKind;
  path: string;
  content: string;
};

export type ParsedRule = Omit<RuleInput, "id">;

export const hashText = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

const toArray = (v: string | string[] | undefined): string[] => {
  if (v === undefined) return [];
  const arr = Array.isArray(v) ? v : v.split(",");
  return arr.map((s) => s.trim()).filter(Boolean);
};

function headingText(h: Heading): string {
  const parts: string[] = [];
  const walk = (n: { value?: string; children?: unknown[] }) => {
    if (typeof n.value === "string") parts.push(n.value);
    for (const c of n.children ?? []) walk(c as typeof n);
  };
  walk(h as never);
  return parts.join("").trim();
}

type Section = { title: string | undefined; body: string };

export function splitSections(markdown: string): Section[] {
  const tree: Root = fromMarkdown(markdown);
  const headings = tree.children.filter((n): n is Heading => n.type === "heading");
  const counts = new Map<number, number>();
  for (const h of headings) counts.set(h.depth, (counts.get(h.depth) ?? 0) + 1);
  const depths = [...counts.keys()].sort((a, b) => a - b);
  const depth = depths.find((d) => (counts.get(d) ?? 0) > 1) ?? depths[0];
  if (depth === undefined) return [{ title: undefined, body: markdown.trim() }];

  const splits = headings.filter((h) => h.depth === depth);
  const sections: Section[] = [];
  const firstOffset = splits[0]!.position!.start.offset!;
  const preamble = markdown.slice(0, firstOffset).trim();
  const preambleIsTitle = /^#{1,6} [^\n]*$/.test(preamble);
  if (preamble && !preambleIsTitle) sections.push({ title: undefined, body: preamble });
  for (const [i, h] of splits.entries()) {
    const start = h.position!.end.offset!;
    const end = splits[i + 1]?.position!.start.offset ?? markdown.length;
    sections.push({ title: headingText(h), body: markdown.slice(start, end).trim() });
  }
  return sections.filter((s) => s.body.length > 0);
}

function base(file: RuleFile, title: string, body: string, section?: string): ParsedRule {
  const r: ParsedRule = {
    key: section ? `${file.path}#${section}` : file.path,
    title,
    body,
    layer: file.layer,
    kind: file.kind,
    path: file.path,
    hash: hashText(`${title}\n${body}`),
  };
  if (section) r.section = section;
  return r;
}

function scopeDirOf(file: RuleFile): string {
  if (file.layer !== "project") return "";
  if (file.kind !== "claude-md" && file.kind !== "agents-md") return "";
  const d = dirname(file.path);
  return d === "." ? "" : d;
}

function parseMarkdownDoc(file: RuleFile): ParsedRule[] {
  const name = basename(file.path);
  const scopeDir = scopeDirOf(file);
  const content = file.content.trim();
  if (!content) return [];
  const sections = splitSections(content);
  return sections.map((s) => {
    const title = s.title ?? (sections.length > 1 ? `${name} (intro)` : name);
    const r = base(file, title, s.body, s.title);
    r.scopeDir = scopeDir;
    return r;
  });
}

function parseCursorRule(file: RuleFile): ParsedRule[] {
  const { data, content } = matter(file.content);
  const description = typeof data.description === "string" ? data.description.trim() : "";
  const title = description || basename(file.path, ".mdc");
  const r = base(file, title, content.trim());
  r.globs = toArray(data.globs as string | string[] | undefined);
  r.alwaysApply = data.alwaysApply === true;
  if (description) r.description = description;
  return content.trim() ? [r] : [];
}

function parseSkill(file: RuleFile): ParsedRule[] {
  const { data, content } = matter(file.content);
  const fallback = basename(file.kind === "skill" ? dirname(file.path) : file.path, ".md");
  const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : fallback;
  const r = base(file, name, content.trim());
  if (typeof data.description === "string") r.description = data.description.trim();
  return [r];
}

function parseCritRule(file: RuleFile): ParsedRule[] {
  const { data, content } = matter(file.content);
  const fm = CritRuleFrontmatter.safeParse(data);
  if (!fm.success) {
    const issues = fm.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new RuleParseError(file.path, `invalid frontmatter (${issues})`);
  }
  const f = fm.data;
  const title = f.title ?? f.id ?? basename(file.path, ".md");
  const r = base(file, title, content.trim());
  if (f.id) r.key = `${file.path}#${f.id}`;
  r.globs = toArray(f.globs);
  if (f.lens) r.lens = f.lens;
  if (f.severity) r.severity = f.severity;
  if (f.alwaysApply) r.alwaysApply = true;
  return [r];
}

export class RuleParseError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.path = path;
    this.name = "RuleParseError";
  }
}

export function parseRuleFile(file: RuleFile): ParsedRule[] {
  switch (file.kind) {
    case "cursor-rule":
      return parseCursorRule(file);
    case "skill":
    case "claude-agent":
      return parseSkill(file);
    case "crit-rule":
      return parseCritRule(file);
    default:
      return parseMarkdownDoc(file);
  }
}
