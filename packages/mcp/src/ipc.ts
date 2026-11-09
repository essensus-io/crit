import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionHandler } from "./server.ts";

type Request = { id: number; token: string; method: keyof SessionHandler; params: unknown[] };
type Response = { id: number; result?: unknown; error?: string };

export type SessionFile = { socket: string; token: string; pid: number };

export type SessionHost = {
  sessionId: string;
  socketPath: string;
  close(): Promise<void>;
};

const METHODS = new Set<string>(["getScope", "getRules", "reportFinding", "finish"]);

export const sessionFilePath = (dir: string, sessionId: string) => join(dir, `${sessionId}.json`);

function socketPathFor(sessionId: string): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\crit-${sessionId}`;
  return join(tmpdir(), `crit-${sessionId.slice(0, 12)}.sock`);
}

function lines(socket: Socket, onLine: (line: string) => void) {
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  });
}

export async function startSessionHost(opts: {
  handler: SessionHandler;
  dir: string;
  sessionId?: string;
}): Promise<SessionHost> {
  const sessionId = opts.sessionId ?? randomBytes(8).toString("hex");
  const token = randomBytes(16).toString("hex");
  const socketPath = socketPathFor(sessionId);
  if (process.platform !== "win32") rmSync(socketPath, { force: true });

  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
    lines(socket, async (line) => {
      let req: Request;
      try {
        req = JSON.parse(line) as Request;
      } catch {
        socket.end();
        return;
      }
      const reply = (r: Response) => socket.write(`${JSON.stringify(r)}\n`);
      if (req.token !== token) return reply({ id: req.id, error: "invalid session token" });
      if (!METHODS.has(req.method))
        return reply({ id: req.id, error: `unknown method ${req.method}` });
      try {
        const fn = opts.handler[req.method] as (...a: unknown[]) => Promise<unknown>;
        reply({ id: req.id, result: await fn.apply(opts.handler, req.params ?? []) });
      } catch (err) {
        reply({ id: req.id, error: (err as Error).message });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  mkdirSync(opts.dir, { recursive: true });
  const file: SessionFile = { socket: socketPath, token, pid: process.pid };
  writeFileSync(sessionFilePath(opts.dir, sessionId), JSON.stringify(file), { mode: 0o600 });

  return {
    sessionId,
    socketPath,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(sessionFilePath(opts.dir, sessionId), { force: true });
      if (process.platform !== "win32") rmSync(socketPath, { force: true });
    },
  };
}

export class SessionNotFoundError extends Error {
  override name = "SessionNotFoundError";
}

export function readSessionFile(dir: string, sessionId: string): SessionFile {
  try {
    return JSON.parse(readFileSync(sessionFilePath(dir, sessionId), "utf8")) as SessionFile;
  } catch {
    throw new SessionNotFoundError(`crit: no active review session ${sessionId}`);
  }
}

export async function connectSession(
  dir: string,
  sessionId: string,
): Promise<SessionHandler & { close(): void }> {
  const file = readSessionFile(dir, sessionId);
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection(file.socket, () => resolve(s));
    s.once("error", reject);
  });
  let next = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  lines(socket, (line) => {
    const res = JSON.parse(line) as Response;
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    if (res.error !== undefined) p.reject(new Error(res.error));
    else p.resolve(res.result);
  });
  socket.on("close", () => {
    for (const p of pending.values()) p.reject(new Error("crit: review session closed"));
    pending.clear();
  });
  const call = <T>(method: keyof SessionHandler, params: unknown[], token = file.token) =>
    new Promise<T>((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      socket.write(`${JSON.stringify({ id, token, method, params } satisfies Request)}\n`);
    });
  return {
    getScope: () => call("getScope", []),
    getRules: (ids) => call("getRules", [ids]),
    reportFinding: (f) => call("reportFinding", [f]),
    finish: (input) => call("finish", [input]),
    close: () => socket.destroy(),
  };
}
