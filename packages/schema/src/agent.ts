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
  /** crit MCP session id; the adapter registers `crit mcp --session <id>` for this run only. */
  mcpSession?: string;
  /**
   * How to start the crit MCP server for this run: the adapter registers
   * `command args` (i.e. `crit mcp --session <id>`) with the agent CLI.
   */
  mcp?: { command: string; args: string[]; sessionsDir: string };
  model?: string;
  timeoutMs: number;
  /** Extra shell commands the agent may run (review.allowedCommands). */
  allowedCommands?: string[];
  /** JSON Schema for the final message when MCP is not available. */
  outputSchema?: Record<string, unknown>;
};

export type AgentEvent =
  | { type: "progress"; text: string }
  | { type: "tool"; name: string }
  | { type: "message"; text: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "rate-limited"; retryAfterMs?: number }
  | { type: "session"; id: string }
  | { type: "error"; message: string }
  | { type: "done"; exitCode: number };

export type DetectResult = {
  installed: boolean;
  version?: string;
  path?: string;
  loggedIn: boolean;
  /** Set when the version is outside the range the contract tests cover. */
  untestedVersion?: boolean;
  hint?: string;
};

export type AdapterCapabilities = {
  /** Can load the crit MCP server headless. */
  mcp: boolean;
  /** Fallback structured output. */
  jsonSchemaOutput: boolean;
  readOnlyMode: boolean;
  /** Rule files the agent loads by itself. */
  nativeContext: RuleSourceKind[];
  models: string[];
};
