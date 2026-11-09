import type { AgentEvent, AgentTask, ProviderProfile } from "@crit/schema";
import type { AdapterEnv, ProviderAdapter } from "../../adapter.ts";
import { detectCli } from "../../detect.ts";
import { streamProcess } from "../../process.ts";
import { buildCursorInvocation, CURSOR_TESTED } from "./cursor-invocation.ts";
import { createCursorStreamParser } from "./cursor-stream-parser.ts";

export const CURSOR_LOGIN_HINT = "run `cursor-agent login`";

export const createCursorAdapter = (
  profile: ProviderProfile,
  env: AdapterEnv,
): ProviderAdapter => ({
  type: "cursor",
  capabilities: {
    mcp: false,
    jsonSchemaOutput: false,
    readOnlyMode: true,
    nativeContext: [
      "cursor-rule" as const,
      "cursorrules" as const,
      "agents-md" as const,
      "claude-md" as const,
    ],
    models: [],
  },
  detect: () => detectCli(profile.command, env.env, CURSOR_TESTED),
  async *run(task: AgentTask, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const invocation = buildCursorInvocation(profile, task);
    const parser = createCursorStreamParser(CURSOR_LOGIN_HINT);
    for await (const event of streamProcess({
      command: invocation.command,
      args: invocation.args,
      cwd: task.cwd,
      env: env.env,
      stdin: invocation.stdin,
      signal,
      timeoutMs: task.timeoutMs,
    })) {
      if (event.kind === "stdout") yield* parser.line(event.line);
      else if (event.kind === "stderr") parser.stderr.push(event.line);
      else yield* parser.exit(event.code, event.timedOut);
    }
  },
});
