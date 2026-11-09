import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AgentEvent, AgentTask, ProviderProfile } from "@crit/schema";
import type { AdapterEnv, ProviderAdapter } from "../../adapter.ts";
import { detectCli } from "../../detect.ts";
import { streamProcess } from "../../process.ts";
import { buildCodexInvocation, CODEX_TESTED } from "./codex-invocation.ts";
import { createCodexStreamParser } from "./codex-stream-parser.ts";

export const CODEX_LOGIN_HINT = "run `codex login`";

export const createCodexAdapter = (profile: ProviderProfile, env: AdapterEnv): ProviderAdapter => ({
  type: "codex",
  capabilities: {
    mcp: true,
    jsonSchemaOutput: true,
    readOnlyMode: true,
    nativeContext: [],
    models: [],
  },
  detect: () => detectCli(profile.command, env.env, CODEX_TESTED),
  async *run(task: AgentTask, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const invocation = buildCodexInvocation(profile, task, env.tmpDir);
    mkdirSync(invocation.cleanupDir, { recursive: true });
    for (const file of invocation.files) writeFileSync(file.path, file.content);
    const parser = createCodexStreamParser(CODEX_LOGIN_HINT);
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
