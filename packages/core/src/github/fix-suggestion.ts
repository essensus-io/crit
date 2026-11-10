import type { LineRange } from "@crit/schema";
import {
  diffPath,
  type ParsedFile,
  type ParsedHunk,
  parseUnifiedDiff,
  rightSideLines,
} from "../diff.ts";

export type FixSuggestion = { range: LineRange; lines: string[] };

const CONTEXT_LINES_KEPT = 1;
const isContext = (line: string) => line.startsWith(" ") || line === "";

const singleHunk = (patch: string, path: string): ParsedHunk | undefined => {
  const files = parseUnifiedDiff(patch);
  const file = files[0];
  if (files.length !== 1 || !file || diffPath(file) !== path || file.hunks.length !== 1)
    return undefined;
  return file.hunks[0];
};

const changedSpan = (body: string[]): { from: number; to: number } | undefined => {
  const changed = body.flatMap((line, index) => (isContext(line) ? [] : [index]));
  if (changed.length === 0) return undefined;
  return { from: changed[0]!, to: changed.at(-1)! };
};

export function trimmedDiff(patch: string, path: string): string {
  const hunk = singleHunk(patch, path);
  if (!hunk)
    return patch
      .split("\n")
      .filter((line) => !/^(---|\+\+\+|@@)/.test(line))
      .join("\n")
      .trim();
  const span = changedSpan(hunk.body);
  if (!span) return hunk.body.join("\n").trim();
  const from = Math.max(0, span.from - CONTEXT_LINES_KEPT);
  return hunk.body
    .slice(from, span.to + 1 + CONTEXT_LINES_KEPT)
    .map((line) => (line === "" ? " " : line))
    .join("\n")
    .trimEnd();
}

const headLines = (files: ParsedFile[], path: string): Map<number, string> => {
  const lines = new Map<number, string>();
  for (const file of files.filter((candidate) => diffPath(candidate) === path))
    for (const hunk of file.hunks)
      rightSideLines(hunk).forEach((text, index) => lines.set(hunk.newStart + index, text));
  return lines;
};

export function fixSuggestion(
  patch: string,
  path: string,
  prFiles: ParsedFile[],
): FixSuggestion | undefined {
  const hunk = singleHunk(patch, path);
  const span = hunk && changedSpan(hunk.body);
  if (!hunk || !span) return undefined;
  const from =
    span.from > 0 && !hunk.body.slice(span.from, span.to + 1).some((l) => l.startsWith("-"))
      ? span.from - 1
      : span.from;
  const slice = hunk.body.slice(from, span.to + 1);
  let oldNumber = hunk.oldStart + hunk.body.slice(0, from).filter((l) => !l.startsWith("+")).length;
  const oldLines: { number: number; text: string }[] = [];
  for (const line of slice) {
    if (line.startsWith("+")) continue;
    oldLines.push({ number: oldNumber++, text: line.slice(1) });
  }
  if (oldLines.length === 0) return undefined;
  const onHead = headLines(prFiles, path);
  if (oldLines.some((old) => onHead.get(old.number) !== old.text)) return undefined;
  return {
    range: { start: oldLines[0]!.number, end: oldLines.at(-1)!.number },
    lines: slice.filter((line) => !line.startsWith("-")).map((line) => line.slice(1)),
  };
}
