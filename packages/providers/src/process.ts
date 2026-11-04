import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { x } from "tinyexec";

/** Find an executable on PATH (with PATHEXT on Windows). */
export function which(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exts =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").concat("")
      : [""];
  const isExec = (p: string) => {
    try {
      if (!statSync(p).isFile()) return false;
      if (process.platform !== "win32") accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (isAbsolute(command) || command.includes("/")) {
    for (const ext of exts) if (isExec(command + ext)) return command + ext;
    return undefined;
  }
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, command + ext);
      if (isExec(p)) return p;
    }
  }
  return undefined;
}

/** `<command> --version`, first semver-looking token; undefined on failure. */
export async function commandVersion(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 10_000,
): Promise<string | undefined> {
  try {
    const r = await x(command, ["--version"], {
      nodeOptions: { env, stdio: ["ignore", "pipe", "pipe"] },
      timeout: timeoutMs,
      throwOnError: false,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    return /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(out)?.[0];
  } catch {
    return undefined;
  }
}

export type LineEvent =
  | { kind: "stdout"; line: string }
  | { kind: "stderr"; line: string }
  | { kind: "exit"; code: number; signal: string | null; timedOut: boolean };

/**
 * Spawn a CLI and yield its stdout/stderr lines as they arrive, then the exit.
 * Aborting the signal or hitting the timeout kills the process tree root.
 */
export async function* streamProcess(opts: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): AsyncGenerator<LineEvent> {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const queue: LineEvent[] = [];
  let wake: (() => void) | undefined;
  const push = (e: LineEvent) => {
    queue.push(e);
    wake?.();
  };
  let timedOut = false;
  const kill = () => {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
  };
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        kill();
      }, opts.timeoutMs)
    : undefined;
  opts.signal?.addEventListener("abort", kill, { once: true });

  const pipeLines = (stream: NodeJS.ReadableStream | null, kind: "stdout" | "stderr") => {
    if (!stream) return Promise.resolve();
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        push({ kind, line: buf.slice(0, i).replace(/\r$/, "") });
        buf = buf.slice(i + 1);
      }
    });
    return new Promise<void>((resolve) =>
      stream.on("end", () => {
        if (buf) push({ kind, line: buf });
        resolve();
      }),
    );
  };
  const outDone = pipeLines(child.stdout, "stdout");
  const errDone = pipeLines(child.stderr, "stderr");
  let spawnError: Error | undefined;
  child.on("error", (err) => (spawnError = err));
  const exited = new Promise<void>((resolve) => {
    child.on("close", async (code, signal) => {
      await Promise.all([outDone, errDone]);
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
      push({ kind: "exit", code: code ?? (spawnError ? 127 : 1), signal, timedOut });
      resolve();
    });
  });
  if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);

  try {
    while (true) {
      if (queue.length === 0) await new Promise<void>((r) => (wake = r));
      wake = undefined;
      while (queue.length) {
        const e = queue.shift()!;
        yield e;
        if (e.kind === "exit") {
          if (spawnError) throw spawnError;
          return;
        }
      }
    }
  } finally {
    kill();
    await exited;
  }
}
