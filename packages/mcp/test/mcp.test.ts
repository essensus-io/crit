import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FindingInput } from "@crit/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  connectSession,
  createCritMcpServer,
  type ReportResult,
  type SessionHandler,
  SessionNotFoundError,
  startSessionHost,
} from "../src/index.ts";

const finding = {
  file: "src/api/payments.ts",
  range: { start: 88, end: 96 },
  anchor: "await provider.refund(order.chargeId, amount);",
  severity: "critical",
  category: "correctness",
  title: "Refund amount not validated",
  explanation: "refund() takes any amount.",
  confidence: 0.92,
};

function fakeHandler(over: Partial<SessionHandler> = {}) {
  const reported: FindingInput[] = [];
  const finished: string[] = [];
  const handler: SessionHandler = {
    getScope: async () => ({
      label: "feature → main",
      files: [
        { path: "src/api/payments.ts", status: "modified", hunks: [{ start: 80, lines: 20 }] },
      ],
      notes: "",
    }),
    getRules: async (ids) =>
      [
        { id: "R1", title: "Errors", path: "CLAUDE.md", body: "Never swallow errors." },
        { id: "R2", title: "Money", path: "CLAUDE.md", body: "Integer cents." },
      ].filter((r) => !ids || ids.includes(r.id)),
    reportFinding: async (f): Promise<ReportResult> => {
      reported.push(f);
      return { accepted: true, id: `f${reported.length}` };
    },
    finish: async (input) => {
      finished.push(input.summary);
      return { ok: true };
    },
    ...over,
  };
  return { handler, reported, finished };
}

async function connect(handler: SessionHandler) {
  const server = createCritMcpServer(handler);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

describe("crit MCP server", () => {
  it("lists the five tools with the finding schema", async () => {
    const client = await connect(fakeHandler().handler);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "get_scope",
      "get_rules",
      "report_finding",
      "report_findings",
      "finish",
    ]);
    const report = tools.find((t) => t.name === "report_finding")!;
    expect(report.inputSchema.required).toEqual(
      expect.arrayContaining(["file", "range", "anchor"]),
    );
    expect(report.inputSchema).not.toHaveProperty("$schema");
  });

  it("returns scope and rules", async () => {
    const client = await connect(fakeHandler().handler);
    const scope = JSON.parse(textOf(await client.callTool({ name: "get_scope", arguments: {} })));
    expect(scope.files[0].path).toBe("src/api/payments.ts");
    const rules = textOf(await client.callTool({ name: "get_rules", arguments: { ids: ["R2"] } }));
    expect(rules).toBe("## R2 Money (CLAUDE.md)\n\nInteger cents.");
    expect(textOf(await client.callTool({ name: "get_rules", arguments: {} }))).toContain(
      "## R1 Errors",
    );
    expect(textOf(await client.callTool({ name: "get_rules", arguments: { ids: ["R9"] } }))).toBe(
      "No matching rules.",
    );
    const bad = await client.callTool({ name: "get_rules", arguments: { ids: "R1" } });
    expect(bad.isError).toBe(true);
  });

  it("records a batch: valid items are kept, invalid ones listed, nothing lost to one bad item", async () => {
    const { handler, reported } = fakeHandler();
    const client = await connect(handler);
    const ok = await client.callTool({
      name: "report_findings",
      arguments: {
        findings: [finding, { ...finding, severity: "blocker" }, { ...finding, title: "Second" }],
      },
    });
    expect(ok.isError).toBeFalsy();
    expect(textOf(ok)).toMatch(/^2 of 3 findings recorded\. Fix and resend the 1 rejected:/);
    expect(textOf(ok)).toContain("#1 recorded as f1");
    expect(textOf(ok)).toContain('#2 rejected:\n  - severity: must be one of "critical"');
    expect(textOf(ok)).toContain("#3 recorded as f2");
    expect(reported.map((f) => f.title)).toEqual([finding.title, "Second"]);

    const none = await client.callTool({ name: "report_findings", arguments: { findings: [{}] } });
    expect(none.isError).toBe(true);
    expect(
      (await client.callTool({ name: "report_findings", arguments: { findings: [] } })).isError,
    ).toBe(true);
    expect((await client.callTool({ name: "report_findings", arguments: {} })).isError).toBe(true);

    const rejecting = await connect({
      ...handler,
      reportFinding: async () => ({ accepted: false, errors: ["not in scope"] }),
    });
    const r = await rejecting.callTool({
      name: "report_findings",
      arguments: { findings: [finding] },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("#1 rejected:\n  - not in scope");
  });

  it("records a valid finding", async () => {
    const { handler, reported } = fakeHandler();
    const client = await connect(handler);
    const r = await client.callTool({ name: "report_finding", arguments: finding });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe("Recorded finding f1.");
    expect(reported[0]).toEqual({ ...finding, ruleIds: [] });
  });

  it("rejects invalid findings with errors the agent can act on", async () => {
    const { handler, reported } = fakeHandler();
    const client = await connect(handler);
    const r = await client.callTool({
      name: "report_finding",
      arguments: {
        ...finding,
        severity: "blocker",
        range: { start: 9, end: 2 },
        anchor: undefined,
      },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatchInlineSnapshot(`
      "Finding rejected. Fix these fields and call report_finding again:
      - range: range.end must be >= range.start
      - anchor: Invalid input: expected string, received undefined
      - severity: must be one of "critical", "major", "minor", "nit""
    `);
    expect(reported).toEqual([]);
  });

  it("passes on handler rejections and warnings", async () => {
    let n = 0;
    const { handler } = fakeHandler({
      reportFinding: async () =>
        ++n === 1
          ? { accepted: false, errors: ["src/x.ts is not in scope (call get_scope)"] }
          : { accepted: true, id: "abc", warnings: ["patch did not apply; kept without fix"] },
    });
    const client = await connect(handler);
    const rejected = await client.callTool({ name: "report_finding", arguments: finding });
    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toContain("- src/x.ts is not in scope (call get_scope)");
    const warned = await client.callTool({ name: "report_finding", arguments: finding });
    expect(textOf(warned)).toBe(
      "Recorded finding abc.\nWarnings:\n- patch did not apply; kept without fix",
    );
  });

  it("finishes, and reports unknown tools and handler errors", async () => {
    const { handler, finished } = fakeHandler({
      getScope: async () => {
        throw new Error("boom");
      },
    });
    const client = await connect(handler);
    expect(
      textOf(await client.callTool({ name: "finish", arguments: { summary: "2 issues" } })),
    ).toBe("Shard finished. Stop now.");
    expect(finished).toEqual(["2 issues"]);
    expect((await client.callTool({ name: "finish", arguments: {} })).isError).toBe(true);
    const unknown = await client.callTool({ name: "write_file", arguments: {} });
    expect(textOf(unknown)).toMatch(/Unknown tool write_file/);
    const err = await client.callTool({ name: "get_scope" });
    expect(textOf(err)).toBe("crit error: boom");
  });
});

describe("session host", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "crit-sessions-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("forwards calls from a connected client", async () => {
    const { handler, reported } = fakeHandler();
    const host = await startSessionHost({ handler, dir });
    const remote = await connectSession(dir, host.sessionId);
    expect((await remote.getScope()).label).toBe("feature → main");
    expect(await remote.getRules(["R1"])).toHaveLength(1);
    expect(await remote.reportFinding({ ...finding, ruleIds: [] } as FindingInput)).toEqual({
      accepted: true,
      id: "f1",
    });
    expect(await remote.finish({ summary: "done" })).toEqual({ ok: true });
    expect(reported).toHaveLength(1);
    remote.close();
    await host.close();
    await expect(connectSession(dir, host.sessionId)).rejects.toThrow(SessionNotFoundError);
  });

  it("keeps sessions isolated and surfaces handler errors", async () => {
    const a = fakeHandler();
    const b = fakeHandler({
      finish: async () => {
        throw new Error("already finished");
      },
    });
    const hostA = await startSessionHost({ handler: a.handler, dir, sessionId: "aaaa1111" });
    const hostB = await startSessionHost({ handler: b.handler, dir, sessionId: "bbbb2222" });
    const toB = await connectSession(dir, "bbbb2222");
    await toB.reportFinding({ ...finding, ruleIds: [] } as FindingInput);
    expect(a.reported).toHaveLength(0);
    expect(b.reported).toHaveLength(1);
    await expect(toB.finish({ summary: "x" })).rejects.toThrow("already finished");
    toB.close();
    await hostA.close();
    await hostB.close();
  });

  it("rejects a wrong token and unknown methods, and fails pending calls on close", async () => {
    const { createConnection } = await import("node:net");
    const { readSessionFile } = await import("../src/ipc.ts");
    let release: () => void = () => {};
    const slow = fakeHandler({
      getScope: () => new Promise((r) => (release = () => r({ label: "", files: [], notes: "" }))),
    });
    const host = await startSessionHost({ handler: slow.handler, dir });
    const file = readSessionFile(dir, host.sessionId);
    const ask = (msg: object) =>
      new Promise<string>((resolve) => {
        const s = createConnection(file.socket, () => s.write(`${JSON.stringify(msg)}\n`));
        s.setEncoding("utf8");
        s.on("data", (d: string) => {
          resolve(d.trim());
          s.destroy();
        });
      });
    expect(JSON.parse(await ask({ id: 1, token: "nope", method: "getScope", params: [] }))).toEqual(
      {
        id: 1,
        error: "invalid session token",
      },
    );
    expect(
      JSON.parse(await ask({ id: 2, token: file.token, method: "constructor", params: [] })).error,
    ).toMatch(/unknown method/);
    const remote = await connectSession(dir, host.sessionId);
    const pending = remote.getScope();
    await new Promise((r) => setTimeout(r, 20));
    await host.close();
    await expect(pending).rejects.toThrow(/session closed/);
    release();
  });
});

describe("stdio entry", () => {
  it("serves MCP on stdio and forwards to the hosting process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crit-stdio-"));
    const { handler, reported } = fakeHandler();
    const host = await startSessionHost({ handler, dir });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dirname, "stdio-entry.ts"), dir, host.sessionId],
      stderr: "pipe",
    });
    const client = new Client({ name: "agent", version: "1" });
    try {
      await client.connect(transport);
      const r = await client.callTool({ name: "report_finding", arguments: finding });
      expect(textOf(r)).toBe("Recorded finding f1.");
      expect(reported).toHaveLength(1);
    } finally {
      await client.close();
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
