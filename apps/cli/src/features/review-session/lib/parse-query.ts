import { type Lens, SEVERITY_ORDER, type Severity } from "@crit/schema";

export type ListFilter = {
  tab: "findings" | "filtered";
  severity?: Severity;
  lens?: Lens;
  file?: string;
  search?: string;
  hasFix?: boolean;
  pending?: boolean;
};

export function parseQuery(query: string): ListFilter {
  const f: ListFilter = { tab: "findings" };
  const words: string[] = [];
  for (const tok of query.trim().split(/\s+/).filter(Boolean)) {
    const [k, ...rest] = tok.split(":");
    const v = rest.join(":");
    if (k === "sev" && (SEVERITY_ORDER as readonly string[]).includes(v))
      f.severity = v as Severity;
    else if (k === "lens" && v) f.lens = v as Lens;
    else if (k === "file" && v) f.file = v;
    else if (k === "is" && v === "filtered") f.tab = "filtered";
    else if (k === "is" && v === "pending") f.pending = true;
    else if (k === "has" && v === "fix") f.hasFix = true;
    else words.push(tok);
  }
  if (words.length) f.search = words.join(" ");
  return f;
}
