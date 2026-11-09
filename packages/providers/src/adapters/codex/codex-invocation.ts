import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AgentTask, ProviderProfile } from "@crit/schema";

export const CODEX_TESTED = { min: "0.160.0", max: "0.199.999" };

const toml = (v: string | string[]) => JSON.stringify(v);

export type CodexInvocation = {
  command: string;
  args: string[];
  stdin: string;
  files: { path: string; content: string }[];
  cleanupDir: string;
};

export const buildCodexInvocation = (
  profile: Pick<ProviderProfile, "command" | "model" | "effort">,
  task: AgentTask,
  tmpDir: string,
): CodexInvocation => {
  const dir = join(tmpDir, `codex-${randomBytes(4).toString("hex")}`);
  const files: CodexInvocation["files"] = [];
  const args = [
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--color",
    "never",
    "-C",
    task.cwd,
    "-c",
    'approval_policy="never"',
    "-c",
    "project_doc_max_bytes=0",
    "--disable",
    "plugins",
    "--disable",
    "apps",
  ];
  if (task.mcp && task.mcpSession) {
    args.push(
      "-c",
      `mcp_servers.crit.command=${toml(task.mcp.command)}`,
      "-c",
      `mcp_servers.crit.args=${toml(task.mcp.args)}`,
      "-c",
      'mcp_servers.crit.default_tools_approval_mode="approve"',
    );
  }
  if (task.outputSchema) {
    const schemaFile = join(dir, "schema.json");
    files.push({ path: schemaFile, content: JSON.stringify(task.outputSchema) });
    args.push("--output-schema", schemaFile);
  }
  const model = task.model ?? profile.model;
  if (model) args.push("-m", model);
  const effort = task.effort ?? profile.effort;
  if (effort) args.push("-c", `model_reasoning_effort=${toml(effort)}`);
  args.push("-");
  const stdin = task.systemPrompt ? `${task.systemPrompt}\n\n---\n\n${task.prompt}` : task.prompt;
  return { command: profile.command, args, stdin, files, cleanupDir: dir };
};
