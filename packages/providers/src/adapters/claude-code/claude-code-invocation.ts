import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AgentTask, ProviderProfile } from "@crit/schema";

export const CLAUDE_TESTED = { min: "2.1.0", max: "2.1.999" };

export const GIT_READ_COMMANDS = [
  "git log",
  "git show",
  "git diff",
  "git blame",
  "git status",
  "git ls-files",
  "git grep",
  "git rev-parse",
];

const DISALLOWED = ["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task", "TodoWrite"];

export type Invocation = {
  command: string;
  args: string[];
  stdin: string;
  files: { path: string; content: string }[];
  cleanupDir: string;
};

export const buildClaudeInvocation = (
  profile: Pick<ProviderProfile, "command" | "model" | "effort">,
  task: AgentTask,
  tmpDir: string,
): Invocation => {
  const dir = join(tmpDir, `claude-${randomBytes(4).toString("hex")}`);
  const files: Invocation["files"] = [];
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--permission-mode",
    "dontAsk",
    "--strict-mcp-config",
  ];
  if (task.mcp && task.mcpSession) {
    const mcpFile = join(dir, "mcp.json");
    files.push({
      path: mcpFile,
      content: JSON.stringify({
        mcpServers: { crit: { type: "stdio", command: task.mcp.command, args: task.mcp.args } },
      }),
    });
    args.push("--mcp-config", mcpFile);
  }
  if (task.systemPrompt) {
    const promptFile = join(dir, "system.md");
    files.push({ path: promptFile, content: task.systemPrompt });
    args.push("--system-prompt-file", promptFile);
  }
  const bashRules = [...GIT_READ_COMMANDS, ...(task.allowedCommands ?? [])].flatMap((c) => [
    `Bash(${c})`,
    `Bash(${c}:*)`,
  ]);
  const access = task.access ?? "shell";
  const tools =
    access === "none"
      ? []
      : access === "read"
        ? ["Read", "Grep", "Glob"]
        : ["Read", "Grep", "Glob", "Bash"];
  args.push("--tools", tools.join(","));
  const allowed = [
    ...tools.filter((t) => t !== "Bash"),
    ...(access === "shell" ? bashRules : []),
    ...(task.mcp ? ["mcp__crit"] : []),
  ];
  if (allowed.length) args.push("--allowedTools", allowed.join(","));
  args.push("--disallowedTools", DISALLOWED.join(","));
  const model = task.model ?? profile.model;
  if (model) args.push("--model", model);
  const effort = task.effort ?? profile.effort;
  if (effort) args.push("--effort", effort);
  return { command: profile.command, args, stdin: task.prompt, files, cleanupDir: dir };
};
