import type { SessionHost } from "@crit/mcp";
import type { AgentTask, Shard } from "@crit/schema";
import { readAtRevision } from "./intake.ts";
import { depthEffort, modelOf } from "./model-of.ts";
import { reviewPrompt, reviewSystemPrompt } from "./prompts.ts";
import type { ReviewRun } from "./review-run.ts";

export const buildReviewTask = async (
  run: ReviewRun,
  shard: Shard,
  useMcp: boolean,
  host: SessionHost | undefined,
): Promise<AgentTask> => {
  const { options, prepared } = run;
  const { scope, rules } = prepared;
  const { config } = options;
  const contents = new Map<string, string>();
  if (scope.diff === undefined)
    for (const file of shard.files) contents.set(file, (await readAtRevision(scope, file)) ?? "");
  return {
    kind: "review",
    cwd: scope.root,
    systemPrompt: reviewSystemPrompt({ mcp: useMcp, diff: scope.diff !== undefined }),
    prompt: reviewPrompt({
      scope,
      files: shard.files,
      lenses: shard.lenses,
      rules,
      contents,
      ...(run.repoSummary ? { repoSummary: run.repoSummary } : {}),
    }),
    timeoutMs: config.review.timeoutMinutes * 60_000,
    allowedCommands: config.review.allowedCommands,
    access: config.review.allowedCommands.length > 0 || config.depth === "deep" ? "shell" : "read",
    ...modelOf(options.provider, "main", depthEffort(config.depth)),
    ...(host
      ? {
          mcpSession: host.sessionId,
          mcp: {
            command: options.mcpCommand.command,
            args: [...options.mcpCommand.args, "--session", host.sessionId],
            sessionsDir: options.sessionsDir,
          },
        }
      : {}),
  };
};
