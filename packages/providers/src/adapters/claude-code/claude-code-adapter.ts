import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AgentEvent, AgentTask, ProviderProfile } from "@crit/schema";
import type { AdapterEnv, ProviderAdapter } from "../../adapter.ts";
import { detectCli } from "../../detect.ts";
import { streamProcess } from "../../process.ts";
import { buildClaudeInvocation, CLAUDE_TESTED } from "./claude-code-invocation.ts";
import { createClaudeStreamParser } from "./claude-stream-parser.ts";

export const CLAUDE_LOGIN_HINT = "run `claude` once to log in";

export const createClaudeCodeAdapter = (
  profile: ProviderProfile,
  env: AdapterEnv,
): ProviderAdapter => ({
  type: "claude-code",
  capabilities: {
    mcp: true,
    jsonSchemaOutput: false,
    readOnlyMode: true,
    nativeContext: [],
    models: ["opus", "sonnet", "haiku"],
  },
  detect: () => detectCli(profile.command, env.env, CLAUDE_TESTED),
  async *run(task: AgentTask, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const invocation = buildClaudeInvocation(profile, task, env.tmpDir);
    mkdirSync(invocation.cleanupDir, { recursive: true });
    for (const file of invocation.files) writeFileSync(file.path, file.content);
    const parser = createClaudeStreamParser(CLAUDE_LOGIN_HINT);
    try {
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
    } finally {
      rmSync(invocation.cleanupDir, { recursive: true, force: true });
    }
  },
});
