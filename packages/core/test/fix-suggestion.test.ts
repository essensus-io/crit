import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/index.ts";
import { fixSuggestion, fixSuggestions, trimmedDiff } from "../src/github/fix-suggestion.ts";

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

describe("fixSuggestions", () => {
  const two = `--- a/f.ts
+++ b/f.ts
@@ -1,2 +1,2 @@
-import a;
+import b;
 x
@@ -10,2 +10,2 @@
 y
-old();
+next();
`;
  const pr = (hunks: string) => parseUnifiedDiff(`--- a/f.ts\n+++ b/f.ts\n${hunks}`);
  const onPr = pr("@@ -1,2 +1,2 @@\n import a;\n x\n@@ -10,2 +10,2 @@\n y\n old();\n");

  it("gives one suggestion per hunk of a fix that changes several places", () => {
    expect(fixSuggestions(two, "f.ts", onPr)).toEqual([
      { range: { start: 1, end: 1 }, lines: ["import b;"] },
      { range: { start: 11, end: 11 }, lines: ["next();"] },
    ]);
  });

  it("gives none when one hunk is not on the pull request diff", () => {
    expect(fixSuggestions(two, "f.ts", pr("@@ -1,2 +1,2 @@\n import a;\n x\n"))).toEqual([]);
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
