import { existsSync, readFileSync } from "node:fs";
import { connectSession, createCritMcpServer } from "@crit/mcp";
import type { AgentEvent, AgentTask, ProviderProfile } from "@crit/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { AdapterEnv, AdapterFactory, ProviderAdapter } from "./adapter.ts";

/**
 * A scripted run. The fake provider replays these instead of calling a real
 * agent: it emits the events, calls the real crit MCP server with the scripted
 * tool calls, and ends with the scripted final message.
 */
export const FakeRun = z.object({
  match: z
    .object({
      kind: z.string().optional(),
      /** Substring the prompt must contain (e.g. a file path in the shard). */
      promptIncludes: z.string().optional(),
    })
    .optional(),
  events: z.array(z.record(z.string(), z.unknown())).default([]),
  calls: z
    .array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).default({}) }))
    .default([]),
  /** Final assistant message (JSON for skeptic / evaluate / JSON-fallback tasks). */
  message: z.string().optional(),
  /**
   * Skeptic helper: answer for every finding id in the prompt. `byTitle` maps a
   * title substring to a verdict; everything else gets `default`.
   */
  skeptic: z
    .object({
      default: z.enum(["confirmed", "plausible", "rejected"]).default("confirmed"),
      byTitle: z.record(z.string(), z.enum(["confirmed", "plausible", "rejected"])).default({}),
    })
    .optional(),
  exitCode: z.number().int().default(0),
  delayMs: z.number().int().min(0).default(0),
  /** Reusable: not consumed when matched. */
  repeat: z.boolean().default(false),
});
export type FakeRun = z.infer<typeof FakeRun>;
export type FakeRunInput = z.input<typeof FakeRun>;

export const FakeScript = z.object({
  /** Reported by detect() as the CLI version. */
  version: z.string().default("0.0.0-fake"),
  loggedIn: z.boolean().default(true),
  runs: z.array(FakeRun).default([]),
});
export type FakeScript = z.infer<typeof FakeScript>;
export type FakeScriptInput = z.input<typeof FakeScript>;

/** Records what the fake was asked to do, for assertions. */
export type FakeCall = { task: AgentTask; run: FakeRun | undefined };

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });

/** Pull `"id": "…"` / `"title": "…"` pairs out of the findings block of a skeptic prompt. */
export function findingsInPrompt(prompt: string): { id: string; title: string }[] {
  const m = /<findings>\s*([\s\S]*?)\s*<\/findings>/.exec(prompt);
  if (!m) return [];
  try {
    const list = JSON.parse(m[1]!) as { id: string; title: string }[];
    return list.map(({ id, title }) => ({ id, title }));
  } catch {
    return [];
  }
}

export class FakeAdapter implements ProviderAdapter {
  readonly type = "fake";
  readonly capabilities = {
    mcp: true,
    jsonSchemaOutput: true,
    readOnlyMode: true,
    nativeContext: [],
    models: ["fake-small", "fake-large"],
  };
  readonly calls: FakeCall[] = [];
  private readonly consumed = new Set<number>();

  private readonly script: FakeScript;
  readonly profile: Pick<ProviderProfile, "model">;
  constructor(script: FakeScript, profile: Pick<ProviderProfile, "model">) {
    this.script = script;
    this.profile = profile;
  }

  static fromFile(path: string, profile: Pick<ProviderProfile, "model">): FakeAdapter {
    const script = existsSync(path)
      ? FakeScript.parse(JSON.parse(readFileSync(path, "utf8")))
      : FakeScript.parse({ loggedIn: false });
    return new FakeAdapter(script, profile);
  }

  async detect() {
    return {
      installed: true,
      version: this.script.version,
      loggedIn: this.script.loggedIn,
      path: "fake",
    };
  }

  private pick(task: AgentTask): FakeRun | undefined {
    for (const [i, run] of this.script.runs.entries()) {
      if (this.consumed.has(i)) continue;
      const m = run.match;
      if (m?.kind && m.kind !== task.kind) continue;
      if (m?.promptIncludes && !task.prompt.includes(m.promptIncludes)) continue;
      if (!run.repeat) this.consumed.add(i);
      return run;
    }
    return undefined;
  }

  async *run(task: AgentTask, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const run = this.pick(task);
    this.calls.push({ task, run });
    if (!run) {
      yield { type: "error", message: `fake provider: no scripted run for ${task.kind}` };
      yield { type: "done", exitCode: 1 };
      return;
    }
    if (run.delayMs) await sleep(run.delayMs, signal);
    for (const e of run.events) yield e as AgentEvent;

    if (run.calls.length) {
      if (!task.mcpSession || !task.mcp)
        throw new Error("fake provider: scripted MCP calls but the task has no MCP session");
      const handler = await connectSession(task.mcp.sessionsDir, task.mcpSession);
      const server = createCritMcpServer(handler);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "fake-agent", version: "0" });
      await Promise.all([server.connect(a), client.connect(b)]);
      try {
        for (const call of run.calls) {
          if (signal.aborted) break;
          yield { type: "tool", name: `mcp__crit__${call.tool}` };
          const result = await client.callTool({ name: call.tool, arguments: call.args });
          const text = (result.content as { text?: string }[])[0]?.text ?? "";
          yield { type: "progress", text: `${call.tool}: ${text.split("\n")[0]}` };
        }
      } finally {
        await client.close();
        handler.close();
      }
    }

    let message = run.message;
    if (run.skeptic) {
      const verdicts = findingsInPrompt(task.prompt).map((f) => {
        const hit = Object.entries(run.skeptic!.byTitle).find(([t]) => f.title.includes(t));
        const verdict = hit?.[1] ?? run.skeptic!.default;
        return { findingId: f.id, verdict, reason: `fake skeptic: ${verdict}` };
      });
      message = JSON.stringify({ results: verdicts });
    }
    if (message !== undefined) yield { type: "message", text: message };
    yield {
      type: "usage",
      inputTokens: task.prompt.length >> 2,
      outputTokens: (message?.length ?? 0) >> 2,
    };
    if (signal.aborted) {
      yield { type: "done", exitCode: 130 };
      return;
    }
    yield { type: "done", exitCode: run.exitCode };
  }
}

/** Shared instances per script path so tests can inspect `calls` and consumed runs. */
const instances = new Map<string, FakeAdapter>();

export const fakeFactory: AdapterFactory = {
  type: "fake",
  label: "Fake (tests)",
  defaultCommand: "fake",
  defaultName: "fake",
  loginHint: "write a fake script",
  models: ["fake-small", "fake-large"],
  hidden: true,
  create(profile: ProviderProfile, env: AdapterEnv) {
    const path = env.env.CRIT_FAKE_SCRIPT ?? profile.command;
    let inst = instances.get(path);
    if (!inst) {
      inst = FakeAdapter.fromFile(path, profile);
      instances.set(path, inst);
    }
    return inst;
  },
};

/** Forget cached fake instances (between tests). */
export function resetFakes(): void {
  instances.clear();
}
