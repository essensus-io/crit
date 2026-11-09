import type { Finding, ResolvedScope } from "@crit/schema";
import type { Repositories } from "@crit/store";
import { reanchor } from "./anchor.ts";
import { readAtRevision } from "./intake.ts";

export const reanchorFindings = async (
  store: Repositories,
  scope: ResolvedScope,
  findings: Finding[],
): Promise<{ moved: number; closed: number }> => {
  let moved = 0;
  let closed = 0;
  for (const finding of findings) {
    if (finding.status !== "open") continue;
    const content = await readAtRevision(scope, finding.file);
    const range =
      content === undefined ? undefined : reanchor(content, finding.anchor, finding.range);
    if (!range) {
      await store.findings.update(finding.id, { status: "closed", selected: false });
      closed++;
    } else if (range.start !== finding.range.start || range.end !== finding.range.end) {
      await store.findings.update(finding.id, { range });
      moved++;
    }
  }
  return { moved, closed };
};
