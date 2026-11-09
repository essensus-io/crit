import type { AgentTask, ProviderProfile } from "@crit/schema";

export const CURSOR_TESTED = { min: "2026.10.0", max: "2026.12.999" };

export const buildCursorInvocation = (
  profile: Pick<ProviderProfile, "command" | "model">,
  task: AgentTask,
) => {
  const args = [
    "-p",
    "--mode",
    "ask",
    "--output-format",
    "stream-json",
    "--trust",
    "--sandbox",
    "enabled",
    "--workspace",
    task.cwd,
  ];
  const model = task.model ?? profile.model;
  if (model) args.push("--model", model);
  const prompt = task.systemPrompt ? `${task.systemPrompt}\n\n---\n\n${task.prompt}` : task.prompt;
  return { command: profile.command, args, stdin: prompt };
};
