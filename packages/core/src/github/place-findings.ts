import type { Finding, LineRange } from "@crit/schema";
import { diffPath, type ParsedFile, type ParsedHunk, rightSideLines } from "../diff.ts";
import { reanchor } from "../pipeline/anchor.ts";

export type InlineFinding = { finding: Finding; range: LineRange };

export type FindingPlacement = { inline: InlineFinding[]; outside: Finding[] };

const placeInHunk = (finding: Finding, hunk: ParsedHunk): LineRange | undefined => {
  const lines = rightSideLines(hunk);
  if (lines.length === 0) return undefined;
  const offset = hunk.newStart - 1;
  const moved = reanchor(lines.join("\n"), finding.anchor, {
    start: finding.range.start - offset,
    end: finding.range.end - offset,
  });
  if (!moved) return undefined;
  return { start: moved.start + offset, end: Math.min(moved.end, lines.length) + offset };
};

const nearestRange = (finding: Finding, ranges: LineRange[]): LineRange | undefined => {
  const distance = (range: LineRange) => Math.abs(range.start - finding.range.start);
  return ranges.reduce<LineRange | undefined>(
    (best, range) => (best === undefined || distance(range) < distance(best) ? range : best),
    undefined,
  );
};

export function placeFindings(findings: Finding[], files: ParsedFile[]): FindingPlacement {
  const placement: FindingPlacement = { inline: [], outside: [] };
  for (const finding of findings) {
    const hunks = files.find((file) => diffPath(file) === finding.file)?.hunks ?? [];
    const range = nearestRange(
      finding,
      hunks.flatMap((hunk) => placeInHunk(finding, hunk) ?? []),
    );
    if (range) placement.inline.push({ finding, range });
    else placement.outside.push(finding);
  }
  return placement;
}
