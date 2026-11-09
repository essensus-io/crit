import { z } from "zod";
import type { RuleSourceKind } from "./rule.ts";

export const AgentTaskKind = z.enum([
  "map",
  "review",
  "skeptic",
  "evaluate-fix",
  "draft-fix",
  "answer",
]);
export type AgentTaskKind = z.infer<typeof AgentTaskKind>;

export type AgentTask = {
  kind: AgentTaskKind;
  cwd: string;
  systemPrompt: string;
  prompt: string;
  mcpSession?: string;
  mcp?: { command: string; args: string[]; sessionsDir: string };
  model?: string;
  effort?: string;
  access?: "none" | "read" | "shell";
  timeoutMs: number;
  allowedCommands?: string[];
  outputSchema?: Record<string, unknown>;
};

export type AgentEvent =
  | { type: "progress"; text: string }
  | { type: "tool"; name: string }
  | { type: "message"; text: string }
  | {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      partial?: boolean;
    }
  | { type: "rate-limited"; retryAfterMs?: number }
  | { type: "session"; id: string }
  | { type: "error"; message: string }
  | { type: "done"; exitCode: number };

export type DetectResult = {
  installed: boolean;
  version?: string;
  path?: string;
  loggedIn: boolean;
  untestedVersion?: boolean;
  hint?: string;
};

export type AdapterCapabilities = {
  mcp: boolean;
  jsonSchemaOutput: boolean;
  readOnlyMode: boolean;
  nativeContext: RuleSourceKind[];
  models: string[];
};
