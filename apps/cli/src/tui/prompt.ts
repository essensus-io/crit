import type { Finding, Fix } from "@crit/schema";
import type { RuleRef } from "./session.ts";

/** A finding written up as a prompt another coding agent can act on. */
export function findingPrompt(finding: Finding, fix: Fix | undefined, rules: RuleRef[]): string {
  const where = `${finding.file}:${finding.range.start}${finding.range.end > finding.range.start ? `-${finding.range.end}` : ""}`;
  const out = [
    `Fix this ${finding.severity} ${finding.category} issue found in code review.`,
    "",
    `Location: ${where}`,
    `Problem: ${finding.title}`,
    "",
    finding.explanation.trim(),
  ];
  if (finding.failureScenario) out.push("", `How it fails: ${finding.failureScenario.trim()}`);
  out.push("", "Code at that location:", "```", finding.anchor, "```");
  if (rules.length)
    out.push("", "Project rules involved:", ...rules.map((r) => `- ${r.title} (${r.path})`));
  if (fix) out.push("", `Suggested fix: ${fix.summary}`, "```diff", fix.patch.trim(), "```");
  out.push(
    "",
    "Make the smallest change that resolves this, keep the surrounding style, and do not touch unrelated code.",
  );
  return `${out.join("\n")}\n`;
}
