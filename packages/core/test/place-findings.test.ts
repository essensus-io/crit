import type { Finding } from "@crit/schema";
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, placeFindings } from "../src/index.ts";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,5 @@
 const one = 1;
-const old = 2;
+const two = 2;
+const three = 3;
 const four = 4;
`;

const finding = (over: Partial<Finding>): Finding => ({
  id: "f1",
  reviewId: "r1",
  fingerprint: "fp",
  file: "src/a.ts",
  range: { start: 11, end: 11 },
  anchor: "const two = 2;",
  severity: "major",
  category: "correctness",
  title: "t",
  explanation: "e",
  confidence: 0.9,
  ruleIds: [],
  status: "open",
  selected: false,
  mergedFrom: [],
  createdAt: 0,
  ...over,
});

const place = (...findings: Finding[]) => placeFindings(findings, parseUnifiedDiff(DIFF));

describe("placeFindings", () => {
  it("keeps a finding that is on a line of the diff", () => {
    expect(place(finding({})).inline[0]?.range).toEqual({ start: 11, end: 11 });
  });

  it("finds the anchor when the local line numbers differ from the pull request", () => {
    const placed = place(finding({ range: { start: 40, end: 40 }, anchor: "const three = 3;" }));
    expect(placed.inline[0]?.range).toEqual({ start: 12, end: 12 });
  });

  it("lists a finding whose code is not in the diff as outside", () => {
    const placed = place(finding({ anchor: "const missing = 0;" }));
    expect(placed.outside).toHaveLength(1);
    expect(placed.inline).toHaveLength(0);
  });

  it("lists a finding in a file the pull request does not touch as outside", () => {
    expect(place(finding({ file: "src/other.ts" })).outside).toHaveLength(1);
  });

  it("clamps a long range to the end of the hunk", () => {
    const placed = place(finding({ range: { start: 11, end: 99 } }));
    expect(placed.inline[0]?.range.end).toBeLessThanOrEqual(13);
  });
});
