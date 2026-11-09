import type { ResolvedConfig } from "@crit/schema";
import type { Rebaser } from "./apply.ts";
import { runAgent } from "./pipeline/agent.ts";
import type { ProviderRun } from "./pipeline/run.ts";

export const DRAFT_FIX_SYSTEM = `You are crit. You write minimal unified diffs. You never edit files yourself.
Reply with ONLY the unified diff in a \`\`\`diff block: headers --- a/<path> and +++ b/<path>, correct @@ hunk headers, and at least 3 lines of context.`;

export function extractDiff(text: string): string | undefined {
  const fenced = /```(?:diff|patch)?\s*\n([\s\S]*?)```/.exec(text)?.[1];
  const body = fenced ?? text;
  const start = body.search(/^--- /m);
  if (start < 0 || !/^\+\+\+ /m.test(body) || !/^@@ /m.test(body)) return undefined;
  const diff = body.slice(start).trimEnd();
  return `${diff}\n`;
}

export function agentRebaser(
  provider: ProviderRun,
  root: string,
  config: Pick<ResolvedConfig, "review">,
): Rebaser {
  return async (item, current, error) => {
    const files = Object.entries(current)
      .map(([path, content]) => `File ${path} as it is now:\n\`\`\`\n${content}\n\`\`\``)
      .join("\n\n");
    const prompt = `A fix no longer applies because another fix changed the same lines first.

Finding: ${item.finding.title} (${item.finding.file}:${item.finding.range.start}-${item.finding.range.end})
${item.finding.explanation}

Original fix (${item.fix.summary}):
\`\`\`diff
${item.fix.patch}\`\`\`

git apply said: ${error}

${files}

Write the same fix again as a unified diff against the file as it is now. Keep the other change.`;
    const out = await runAgent(
      provider.adapter,
      {
        kind: "draft-fix",
        cwd: root,
        systemPrompt: DRAFT_FIX_SYSTEM,
        prompt,
        timeoutMs: config.review.timeoutMinutes * 60_000,
        ...(provider.profile.model ? { model: provider.profile.model } : {}),
      },
      new AbortController().signal,
    );
    return out.message ? extractDiff(out.message) : undefined;
  };
}
