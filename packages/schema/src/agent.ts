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
  /**
   * What the agent may use besides crit's own tools. Tool definitions are resent
   * every turn (Claude Code: ~1.5k tokens for the shell alone, ~2.6k for file
   * tools), so tasks get only what they need. Default "shell".
   * - none: nothing; the prompt carries everything
   * - read: read and search files
   * - shell: read plus read-only git and the allowlisted commands
   */
  access?: "none" | "read" | "shell";
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
  | {
      type: "usage";
      /** Fresh (uncached) input tokens. */
      inputTokens?: number;
      outputTokens?: number;
      /** Input tokens served from the provider's prompt cache. */
      cachedInputTokens?: number;
      /** A cumulative running total for the run so far, superseded by the final usage event. */
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
