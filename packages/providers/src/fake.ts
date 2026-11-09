import { existsSync, readFileSync } from "node:fs";
import { connectSession, createCritMcpServer } from "@crit/mcp";
import type { AgentEvent, AgentTask, ProviderProfile } from "@crit/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { AdapterEnv, AdapterFactory } from "./adapter.ts";

export const FakeRun = z.object({
  match: z
    .object({
      kind: z.string().optional(),
      promptIncludes: z.string().optional(),
    })
    .optional(),
  events: z.array(z.record(z.string(), z.unknown())).default([]),
  calls: z
    .array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).default({}) }))
    .default([]),
  message: z.string().optional(),
  skeptic: z
    .object({
      default: z.enum(["confirmed", "plausible", "rejected"]).default("confirmed"),
      byTitle: z.record(z.string(), z.enum(["confirmed", "plausible", "rejected"])).default({}),
    })
    .optional(),
  exitCode: z.number().int().default(0),
  delayMs: z.number().int().min(0).default(0),
  repeat: z.boolean().default(false),
});
export type FakeRun = z.infer<typeof FakeRun>;
export type FakeRunInput = z.input<typeof FakeRun>;

export const FakeScript = z.object({
  version: z.string().default("0.0.0-fake"),
  loggedIn: z.boolean().default(true),
  runs: z.array(FakeRun).default([]),
});
export type FakeScript = z.infer<typeof FakeScript>;
export type FakeScriptInput = z.input<typeof FakeScript>;

export type FakeCall = { task: AgentTask; run: FakeRun | undefined };

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });

export function findingsInPrompt(prompt: string): { id: string; title: string }[] {
  const match = /<findings>\s*([\s\S]*?)\s*<\/findings>/.exec(prompt);
  if (!match) return [];
  try {
    const list = JSON.parse(match[1]!) as { id: string; title: string }[];
    return list.map(({ id, title }) => ({ id, title }));
  } catch {
    return [];
  }
}

export const createFakeAdapter = (script: FakeScript, profile: Pick<ProviderProfile, "model">) => {
  const calls: FakeCall[] = [];
  const consumed = new Set<number>();

  const pick = (task: AgentTask): FakeRun | undefined => {
    for (const [index, run] of script.runs.entries()) {
      if (consumed.has(index)) continue;
      const match = run.match;
      if (match?.kind && match.kind !== task.kind) continue;
      if (match?.promptIncludes && !task.prompt.includes(match.promptIncludes)) continue;
      if (!run.repeat) consumed.add(index);
      return run;
    }
    return undefined;
  };

  async function* run(task: AgentTask, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const scripted = pick(task);
    calls.push({ task, run: scripted });
    if (!scripted) {
      yield { type: "error", message: `fake provider: no scripted run for ${task.kind}` };
      yield { type: "done", exitCode: 1 };
      return;
    }
    if (scripted.delayMs) await sleep(scripted.delayMs, signal);
    for (const event of scripted.events) yield event as AgentEvent;

    if (scripted.calls.length) {
      if (!task.mcpSession || !task.mcp)
        throw new Error("fake provider: scripted MCP calls but the task has no MCP session");
      const handler = await connectSession(task.mcp.sessionsDir, task.mcpSession);
      const server = createCritMcpServer(handler);
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "fake-agent", version: "0" });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        for (const call of scripted.calls) {
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

    let message = scripted.message;
    if (scripted.skeptic) {
      const skeptic = scripted.skeptic;
      const verdicts = findingsInPrompt(task.prompt).map((finding) => {
        const hit = Object.entries(skeptic.byTitle).find(([title]) =>
          finding.title.includes(title),
        );
        const verdict = hit?.[1] ?? skeptic.default;
        return { findingId: finding.id, verdict, reason: `fake skeptic: ${verdict}` };
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
    yield { type: "done", exitCode: scripted.exitCode };
  }

  return {
    type: "fake" as const,
    capabilities: {
      mcp: true,
      jsonSchemaOutput: true,
      readOnlyMode: true,
      nativeContext: [],
      models: ["fake-small", "fake-large"],
    },
    calls,
    profile,
    detect: async () => ({
      installed: true,
      version: script.version,
      loggedIn: script.loggedIn,
      path: "fake",
    }),
    run,
  };
};

export type FakeAdapter = ReturnType<typeof createFakeAdapter>;

export const createFakeAdapterFromFile = (
  path: string,
  profile: Pick<ProviderProfile, "model">,
): FakeAdapter => {
  const script = existsSync(path)
    ? FakeScript.parse(JSON.parse(readFileSync(path, "utf8")))
    : FakeScript.parse({ loggedIn: false });
  return createFakeAdapter(script, profile);
};

const instances = new Map<string, FakeAdapter>();

export const fakeFactory: AdapterFactory = {
  type: "fake",
  label: "Fake (tests)",
  defaultCommand: "fake",
  defaultName: "fake",
  loginHint: "write a fake script",
  models: ["fake-small", "fake-large"],
  efforts: ["low", "high"],
  hidden: true,
  create(profile: ProviderProfile, env: AdapterEnv) {
    const path = env.env.CRIT_FAKE_SCRIPT ?? profile.command;
    let inst = instances.get(path);
    if (!inst) {
      inst = createFakeAdapterFromFile(path, profile);
      instances.set(path, inst);
    }
    return inst;
  },
};

export function resetFakes(): void {
  instances.clear();
}
