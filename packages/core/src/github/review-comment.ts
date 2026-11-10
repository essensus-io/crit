import type { Finding, Fix } from "@crit/schema";
import { type FixSuggestion, trimmedDiff } from "./fix-suggestion.ts";

const ZERO_WIDTH_SPACE = "​";
const CODE_SPAN = /(`[^`]*`)/;
const MENTION = /(^|\W)@(?=\w)/g;
const MARKER = /<!-- crit:(\S+) -->/g;
const MIN_FENCE = 3;

export const findingMarker = (fingerprint: string) => `<!-- crit:${fingerprint} -->`;

export const fingerprintsIn = (text: string): string[] =>
  [...text.matchAll(MARKER)].map((match) => match[1]!);

export const defuseMentions = (text: string): string =>
  text
    .split(CODE_SPAN)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(MENTION, `$1@${ZERO_WIDTH_SPACE}`),
    )
    .join("");

const fenceFor = (code: string) => {
  const longestRun = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(MIN_FENCE, longestRun + 1));
};

const fixBlock = (finding: Finding, fix: Fix, suggestion: FixSuggestion | undefined) => {
  const summary = `**Suggested fix:** ${defuseMentions(fix.summary)}`;
  if (suggestion) {
    const code = suggestion.lines.join("\n");
    const fence = fenceFor(code);
    return `${summary}\n\n${fence}suggestion\n${code ? `${code}\n` : ""}${fence}`;
  }
  const diff = trimmedDiff(fix.patch, finding.file);
  const fence = fenceFor(diff);
  return `${summary}\n\n${fence}diff\n${diff}\n${fence}`;
};

export function findingComment(
  finding: Finding,
  fix: Fix | undefined,
  suggestion?: FixSuggestion,
): string {
  const parts = [
    `**${finding.severity} · ${finding.category}** · ${defuseMentions(finding.title)}`,
    defuseMentions(finding.explanation),
  ];
  if (finding.failureScenario)
    parts.push(`**Fails when:** ${defuseMentions(finding.failureScenario)}`);
  if (fix) parts.push(fixBlock(finding, fix, suggestion));
  parts.push(findingMarker(finding.fingerprint));
  return parts.join("\n\n");
}

const location = (finding: Finding) =>
  finding.range.start === finding.range.end
    ? `${finding.file}:${finding.range.start}`
    : `${finding.file}:${finding.range.start}-${finding.range.end}`;

const outsideEntry = (finding: Finding) => {
  const explanation = defuseMentions(finding.explanation).replace(/\s+/g, " ").trim();
  return `- \`${location(finding)}\` **${finding.severity}** · ${defuseMentions(finding.title)}: ${explanation} ${findingMarker(finding.fingerprint)}`;
};

export function reviewBody(inlineCount: number, outside: Finding[]): string {
  const total = inlineCount + outside.length;
  const intro = `**crit** found ${total} issue${total === 1 ? "" : "s"} on this pull request.`;
  if (outside.length === 0) return intro;
  return [intro, "**Not on a line of this diff:**", outside.map(outsideEntry).join("\n")].join(
    "\n\n",
  );
}
