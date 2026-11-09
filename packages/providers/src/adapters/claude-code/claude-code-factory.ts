import type { AdapterFactory } from "../../adapter.ts";
import { claudeModels } from "../../models.ts";
import { CLAUDE_LOGIN_HINT, createClaudeCodeAdapter } from "./claude-code-adapter.ts";

export const claudeCodeFactory: AdapterFactory = {
  type: "claude-code",
  label: "Claude Code",
  defaultCommand: "claude",
  defaultName: "claude",
  loginHint: CLAUDE_LOGIN_HINT,
  models: [
    "opus",
    "sonnet",
    "haiku",
    "opusplan",
    "sonnet[1m]",
    "claude-fable-5-1",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
  ],
  listModels: ({ env, timeoutMs }) => claudeModels(env, timeoutMs),
  efforts: ["low", "medium", "high", "xhigh", "max"],
  create: createClaudeCodeAdapter,
};
