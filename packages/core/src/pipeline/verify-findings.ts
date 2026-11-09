import {
  addUsage,
  type AgentTask,
  emptyUsage,
  type Finding,
  type ResolvedConfig,
  type ResolvedScope,
  SkepticResult,
  type TokenUsage,
} from "@crit/schema";
import { z } from "zod";
import { runAgent } from "./agent.ts";
import { excerpt } from "./anchor.ts";
import { readAtRevision } from "./intake.ts";
import { modelOf } from "./model-of.ts";
import { parseJsonReply, repairPrompt, skepticPrompt, skepticSystem } from "./prompts.ts";
import type { ProviderRun } from "./review-types.ts";

const SkepticJson = z.object({ results: z.array(SkepticResult) });

export type VerifyOptions = { fast?: boolean; deep?: boolean; chunkSize?: number };

export const verify = async (
  findings: Finding[],
  skeptic: ProviderRun,
  scope: ResolvedScope,
  config: Pick<ResolvedConfig, "review">,
  signal: AbortSignal,
  options: VerifyOptions = {},
): Promise<{ results: Map<string, SkepticResult>; warnings: string[]; usage: TokenUsage }> => {
  const chunkSize = options.chunkSize ?? 15;
  const results = new Map<string, SkepticResult>();
  const warnings: string[] = [];
  let usage = emptyUsage();
  for (let start = 0; start < findings.length; start += chunkSize) {
    const chunk = findings.slice(start, start + chunkSize);
    const items = await Promise.all(
      chunk.map(async (finding) => ({
        finding,
        excerpt: excerpt(
          (await readAtRevision(scope, finding.file)) ?? "",
          finding.range,
          options.deep ? 6 : 20,
        ),
      })),
    );
    const task: AgentTask = {
      kind: "skeptic",
      cwd: scope.root,
      systemPrompt: skepticSystem(options.deep === true),
      access: options.deep ? "read" : "none",
      prompt: skepticPrompt(items),
      timeoutMs: config.review.timeoutMinutes * 60_000,
      ...modelOf(skeptic, options.fast ? "fast" : "main"),
    };
    let outcome = await runAgent(skeptic.adapter, task, signal);
    usage = addUsage(usage, outcome);
    let parsed = parseJsonReply(outcome.message ?? "", SkepticJson);
    if (!parsed.ok && outcome.exitCode === 0) {
      outcome = await runAgent(
        skeptic.adapter,
        { ...task, prompt: `${task.prompt}\n\n${repairPrompt(parsed.error)}` },
        signal,
      );
      usage = addUsage(usage, outcome);
      parsed = parseJsonReply(outcome.message ?? "", SkepticJson);
    }
    if (!parsed.ok) {
      warnings.push(
        `skeptic pass failed for ${chunk.length} findings: ${outcome.errors.join("; ") || parsed.error}`,
      );
      continue;
    }
    const ids = new Set(chunk.map((finding) => finding.id));
    for (const result of parsed.data.results)
      if (ids.has(result.findingId)) results.set(result.findingId, result);
    for (const finding of chunk) {
      if (!results.has(finding.id))
        results.set(finding.id, {
          findingId: finding.id,
          verdict: "plausible",
          reason: "the skeptic gave no verdict",
        });
    }
  }
  return { results, warnings, usage };
};
