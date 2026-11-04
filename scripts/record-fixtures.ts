/**
 * Re-record adapter contract fixtures from the real agent CLIs.
 *
 *   pnpm fixtures:record [claude-code] [codex] [cursor]
 *
 * Runs one tiny, read-only review per CLI on a throwaway repo with the crit MCP
 * server attached, and saves the scrubbed stdout stream next to the findings
 * the agent reported. Uses your own CLI login; costs a few cents at most.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionHandler, startSessionHost } from "../packages/mcp/src/index.ts";
import type { AgentTask, FindingInput } from "../packages/schema/src/index.ts";
import { createFixtureRepo } from "../packages/testkit/src/index.ts";
import { scrubTranscript } from "./scrub.ts";

const FIXTURES = join(import.meta.dirname, "..", "packages", "providers", "test", "fixtures");

const BUGGY = `export function refund(order: { captured: number }, amount: number) {
  // BUG: amount is never checked against the captured amount
  return { refunded: amount };
}
`;

type Recorder = {
  type: string;
  model: string;
  invoke(
    task: AgentTask,
    tmp: string,
  ): Promise<{ command: string; args: string[]; stdin?: string; cleanup?: string }>;
};

const recorders: Record<string, Recorder> = {
  "claude-code": {
    type: "claude-code",
    model: "haiku",
    async invoke(task, tmp) {
      const { buildClaudeInvocation } =
        await import("../packages/providers/src/adapters/claude-code.ts");
      const inv = buildClaudeInvocation({ command: "claude", model: this.model }, task, tmp);
      mkdirSync(inv.cleanupDir, { recursive: true });
      for (const f of inv.files) writeFileSync(f.path, f.content);
      return { command: inv.command, args: inv.args, stdin: inv.stdin, cleanup: inv.cleanupDir };
    },
  },
};

async function record(name: string): Promise<void> {
  const rec = recorders[name];
  if (!rec) throw new Error(`no recorder for ${name}; have ${Object.keys(recorders).join(", ")}`);
  const repo = createFixtureRepo({ "src/refund.ts": BUGGY });
  const sessions = mkdtempSync(join(tmpdir(), "crit-rec-"));
  const findings: FindingInput[] = [];
  const handler: SessionHandler = {
    getScope: async () => ({
      label: "src/refund.ts",
      files: [{ path: "src/refund.ts", status: "unchanged" }],
      notes: "",
    }),
    getRules: async () => [],
    reportFinding: async (f) => {
      findings.push(f);
      return { accepted: true, id: `f${findings.length}` };
    },
    finish: async () => ({ ok: true }),
  };
  const host = await startSessionHost({ handler, dir: sessions });
  const task: AgentTask = {
    kind: "review",
    cwd: repo.root,
    systemPrompt:
      "You are a code reviewer. Report each issue with the crit report_finding tool, then call finish.",
    prompt:
      "Review src/refund.ts. Report exactly one finding for the most important bug with report_finding (include a fix patch), then call finish.",
    mcpSession: host.sessionId,
    mcp: {
      command: process.execPath,
      args: [join(import.meta.dirname, "mcp-entry.ts"), sessions, host.sessionId],
      sessionsDir: sessions,
    },
    timeoutMs: 180_000,
  };
  const { streamProcess } = await import("../packages/providers/src/process.ts");
  const inv = await rec.invoke(task, sessions);
  const lines: string[] = [];
  let exit = 0;
  for await (const e of streamProcess({
    command: inv.command,
    args: inv.args,
    cwd: repo.root,
    stdin: inv.stdin,
    timeoutMs: task.timeoutMs,
  })) {
    if (e.kind === "stdout") lines.push(e.line);
    else if (e.kind === "stderr") process.stderr.write(`[${name}] ${e.line}\n`);
    else exit = e.code;
  }
  await host.close();
  const dir = join(FIXTURES, name);
  mkdirSync(dir, { recursive: true });
  const scrubbed = scrubTranscript(lines, { repo: repo.root, home: homedir(), extra: [sessions] });
  writeFileSync(join(dir, "review.jsonl"), `${scrubbed.join("\n")}\n`);
  writeFileSync(join(dir, "review.findings.json"), `${JSON.stringify(findings, null, 2)}\n`);
  console.log(`${name}: exit ${exit}, ${lines.length} lines, ${findings.length} findings → ${dir}`);
  repo.cleanup();
  rmSync(sessions, { recursive: true, force: true });
}

const which = process.argv.slice(2);
for (const name of which.length ? which : Object.keys(recorders)) await record(name);
