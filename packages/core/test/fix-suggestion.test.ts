import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/index.ts";
import { fixSuggestion, trimmedDiff } from "../src/github/fix-suggestion.ts";

const PATH = "packages/api/src/lib/timesheet-lock.ts";
const FILE_LINES = [
  "  return false;",
  "}",
  "",
  "if (dayKey >= state.lockedThroughDate) {",
  "  return false;",
  "}",
];
const PATCH = `--- a/${PATH}
+++ b/${PATH}
@@ -135,7 +135,7 @@
   return false;
 }
 
-if (dayKey >= state.lockedThroughDate) {
+if (dayKey > state.lockedThroughDate) {
   return false;
 }
`;
const prDiff = (start: number) =>
  parseUnifiedDiff(
    `--- a/${PATH}\n+++ b/${PATH}\n@@ -${start},6 +${start},6 @@\n${FILE_LINES.map((line) => ` ${line}`).join("\n")}\n`,
  );

describe("fixSuggestion", () => {
  it("turns a one-line fix into a suggestion on just the line it changes", () => {
    expect(fixSuggestion(PATCH, PATH, prDiff(135))).toEqual({
      range: { start: 138, end: 138 },
      lines: ["if (dayKey > state.lockedThroughDate) {"],
    });
  });

  it("gives up when the line on the pull request is not the one the fix expects", () => {
    expect(fixSuggestion(PATCH, PATH, prDiff(200))).toBeUndefined();
  });
});

describe("trimmedDiff", () => {
  it("drops the file headers and the hunk header and keeps one line of context", () => {
    const diff = trimmedDiff(PATCH, PATH);
    expect(diff).not.toContain("---");
    expect(diff).not.toContain("+++");
    expect(diff).not.toContain("@@");
    expect(diff.split("\n")).toEqual([
      " ",
      "-if (dayKey >= state.lockedThroughDate) {",
      "+if (dayKey > state.lockedThroughDate) {",
      "   return false;",
    ]);
  });
});
