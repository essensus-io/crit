import { effectiveTokens } from "@crit/schema";
import { runAgent } from "./agent.ts";
import { modelOf } from "./model-of.ts";
import { MAP_SYSTEM, mapPrompt } from "./prompts.ts";
import { reportUsage, type ReviewRun } from "./review-run.ts";

const MAP_TTL_MS = 7 * 86_400_000;

export const mapRepository = async (run: ReviewRun, shardCount: number) => {
  const { options, prepared } = run;
  if (options.spec.kind !== "project" || shardCount === 0) return undefined;
  const { store, config } = options;
  const key = `map:${prepared.repo.id}`;
  const hit = await store.kv.get(key);
  const fresh = hit ? (JSON.parse(hit) as { at: number; text: string }) : undefined;
  if (fresh && run.now() - fresh.at < MAP_TTL_MS) return fresh.text;
  const outcome = await runAgent(
    options.provider.adapter,
    {
      kind: "map",
      cwd: prepared.scope.root,
      systemPrompt: MAP_SYSTEM,
      prompt: mapPrompt(prepared.scope.files.map((file) => file.path)),
      timeoutMs: config.review.timeoutMinutes * 60_000,
      ...modelOf(options.provider, "fast"),
    },
    run.signal,
  );
  run.finishedSpend += effectiveTokens(outcome);
  reportUsage(run, "map");
  if (outcome.ok && outcome.message) {
    const summary = outcome.message.trim();
    await store.kv.set(key, JSON.stringify({ at: run.now(), text: summary }));
    return summary;
  }
  run.emit({
    type: "warning",
    message: `repo map pass failed: ${outcome.errors.join("; ") || `exit ${outcome.exitCode}`}`,
  });
  return undefined;
};
