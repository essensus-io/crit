import { type AgentTask, FindingInput as FindingInputSchema, type Shard } from "@crit/schema";
import { z } from "zod";
import { type AgentOutcome, runAgent } from "./agent.ts";
import { parseJsonReply, repairPrompt } from "./prompts.ts";
import type { ShardReport, ShardState } from "./report-shard-finding.ts";
import type { ReviewRun } from "./review-run.ts";

const ReviewJson = z.object({ findings: z.array(z.unknown()), summary: z.string().default("") });

export const recoverJsonFindings = async (
  run: ReviewRun,
  shard: Shard,
  task: AgentTask,
  firstOutcome: AgentOutcome,
  report: ShardReport,
  state: ShardState,
): Promise<AgentOutcome> => {
  let outcome = firstOutcome;
  let parsed = parseJsonReply(outcome.message ?? "", ReviewJson);
  if (!parsed.ok) {
    const again = await runAgent(
      run.options.provider.adapter,
      { ...task, prompt: `${task.prompt}\n\n${repairPrompt(parsed.error)}` },
      run.signal,
    );
    parsed = parseJsonReply(again.message ?? "", ReviewJson);
    outcome = {
      ...again,
      inputTokens: outcome.inputTokens + again.inputTokens,
      outputTokens: outcome.outputTokens + again.outputTokens,
      cachedInputTokens: outcome.cachedInputTokens + again.cachedInputTokens,
    };
  }
  if (!parsed.ok) {
    outcome.errors.push(`could not parse the agent's JSON output: ${parsed.error}`);
    return outcome;
  }
  state.summary = parsed.data.summary || null;
  for (const raw of parsed.data.findings) {
    const finding = FindingInputSchema.safeParse(raw);
    if (finding.success) await report(finding.data, false);
    else
      run.emit({
        type: "finding-rejected",
        shardId: shard.id,
        errors: finding.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      });
  }
  return outcome;
};
