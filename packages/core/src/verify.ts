import { spawn } from "node:child_process";
import type { VerifyResult } from "@crit/schema";

const tail = (s: string, max = 4000) => (s.length > max ? `…${s.slice(-max)}` : s);

export function runShell(
  command: string,
  cwd: string,
  timeoutMs = 10 * 60_000,
  env: NodeJS.ProcessEnv = process.env,
) {
  return new Promise<{ exitCode: number; output: string; durationMs: number }>((resolve) => {
    const t0 = Date.now();
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => {
      output += `\n[crit] timed out after ${Math.round(timeoutMs / 1000)}s`;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, output: tail(output), durationMs: Date.now() - t0 });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, output: err.message, durationMs: Date.now() - t0 });
    });
  });
}

export async function runVerify(
  commands: string[],
  cwd: string,
  timeoutMs?: number,
): Promise<VerifyResult> {
  const results: VerifyResult["commands"] = [];
  for (const command of commands) {
    const result = await runShell(command, cwd, timeoutMs);
    results.push({
      command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      output: result.output,
    });
    if (result.exitCode !== 0) break;
  }
  return {
    passed: results.length === commands.length && results.every((result) => result.exitCode === 0),
    commands: results,
  };
}
