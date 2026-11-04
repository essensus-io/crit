import { describe, expect, it } from "vitest";
import { addedLines, diffPath, hunksOf, parseUnifiedDiff } from "../src/diff.ts";

const GIT_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 export { a };
@@ -10 +11,2 @@ function x() {
-old
+new
+newer
diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+one
+two
\\ No newline at end of file
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old name.ts b/new name.ts
similarity index 100%
rename from old name.ts
rename to new name.ts
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
`;

describe("parseUnifiedDiff", () => {
  const files = parseUnifiedDiff(GIT_DIFF);

  it("finds every file with its status", () => {
    expect(files.map((f) => [diffPath(f), f.status, f.binary])).toEqual([
      ["src/a.ts", "modified", false],
      ["new.ts", "added", false],
      ["gone.ts", "deleted", false],
      ["new name.ts", "renamed", false],
      ["logo.png", "modified", true],
    ]);
    expect(files[3]!.oldPath).toBe("old name.ts");
    expect(files[1]!.oldPath).toBeNull();
    expect(files[2]!.newPath).toBeNull();
  });

  it("parses hunk ranges, including omitted counts", () => {
    expect(hunksOf(files[0]!)).toEqual([
      { start: 1, lines: 4 },
      { start: 11, lines: 2 },
    ]);
    expect(files[0]!.hunks[1]!.oldLines).toBe(1);
    expect(hunksOf(files[2]!)).toEqual([{ start: 0, lines: 0 }]);
  });

  it("keeps the no-newline marker and the raw text of each file", () => {
    expect(files[1]!.hunks[0]!.body.at(-1)).toBe("\\ No newline at end of file");
    expect(files[0]!.text.startsWith("diff --git a/src/a.ts")).toBe(true);
    expect(
      files[0]!.text.endsWith(
        " export { a };\n@@ -10 +11,2 @@ function x() {\n-old\n+new\n+newer\n",
      ),
    ).toBe(true);
  });

  it("lists added lines on the new side", () => {
    expect([...addedLines(files[0]!)]).toEqual([2, 3, 11, 12]);
  });

  it("parses plain diffs without git headers", () => {
    const plain =
      "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n--- a/y.ts\n+++ b/y.ts\n@@ -2,0 +3 @@\n+c\n";
    const p = parseUnifiedDiff(plain);
    expect(p.map(diffPath)).toEqual(["x.ts", "y.ts"]);
    expect(hunksOf(p[1]!)).toEqual([{ start: 3, lines: 1 }]);
  });

  it("handles quoted paths, timestamps and truncated hunks", () => {
    const d =
      '--- "a/sp ace.ts"\t2020-01-01\n+++ "b/sp ace.ts"\t2020-01-01\n@@ -1,3 +1,3 @@\n-a\n+b\ngarbage\n';
    const [f] = parseUnifiedDiff(d);
    expect(diffPath(f!)).toBe("sp ace.ts");
    expect(f!.hunks[0]!.body).toEqual(["-a", "+b"]);
  });

  it("treats empty context lines as context", () => {
    const d = "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n";
    expect([...addedLines(parseUnifiedDiff(d)[0]!)]).toEqual([3]);
  });

  it("returns nothing for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("random text\n")).toEqual([]);
  });
});
