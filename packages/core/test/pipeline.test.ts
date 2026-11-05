import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAdapter, type FakeRunInput, FakeScript, type FakeScriptInput } from "@crit/providers";
import {
  type AgentEvent,
  type AgentTask,
  DEFAULT_CONFIG,
  type FindingInput,
  type ResolvedConfig,
  type ReviewEvent,
} from "@crit/schema";
import { openStore, type SqliteStore } from "@crit/store";
import { createFixtureRepo, type FixtureRepo } from "@crit/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentRunner,
  fingerprint,
  Intake,
  prepareReview,
  reanchorFindings,
  resolveScope,
  type ReviewOptions,
  runReview,
} from "../src/index.ts";

const PAYMENTS_BASE = `export async function refund(orders, provider, orderId, amount) {
  const order = await orders.get(orderId);
  return provider.refund(order.chargeId, amount);
}
`;
const PAYMENTS_FEATURE = `export async function refund(orders, provider, orderId, amount) {
  const order = await orders.get(orderId);
  try {
    await provider.refund(order.chargeId, amount);
  } catch (e) {}
  return order;
}
`;
const FIX_PATCH = `--- a/src/api/payments.ts
+++ b/src/api/payments.ts
@@ -1,6 +1,9 @@
 export async function refund(orders, provider, orderId, amount) {
   const order = await orders.get(orderId);
+  if (amount <= 0 || amount > order.capturedAmount - order.refundedAmount) {
+    throw new Error("refund exceeds captured amount");
+  }
   try {
     await provider.refund(order.chargeId, amount);
   } catch (e) {}
`;

const refundFinding = (over: Partial<FindingInput> = {}) => ({
  file: "src/api/payments.ts",
  range: { start: 4, end: 4 },
  anchor: "await provider.refund(order.chargeId, amount);",
  severity: "critical",
  category: "correctness",
  title: "Refund amount not validated",
  explanation: "refund() takes any amount.",
  failureScenario: "amount 5000 on a 2000 capture",
  confidence: 0.92,
  ruleIds: ["R1", "R99"],
  fix: { summary: "Validate amount", patch: FIX_PATCH },
  ...over,
});
const swallowFinding = {
  file: "src/api/payments.ts",
  range: { start: 5, end: 5 },
  anchor: "} catch (e) {}",
  severity: "minor",
  category: "correctness",
  title: "Error swallowed in catch block",
  explanation: "Errors from the provider are ignored.",
  confidence: 0.7,
};

let repo: FixtureRepo;
let store: SqliteStore;
let dir: string;

beforeEach(() => {
  repo = createFixtureRepo({
    "src/api/payments.ts": PAYMENTS_BASE,
    "src/db/orders.ts": "export const list = () => [];\n",
    ".crit/rules/money.md":
      "---\ntitle: Validate money inputs at the boundary\nglobs: src/api/**\n---\nCheck amounts.\n",
  });
  repo.git("checkout", "-q", "-b", "feature/payments");
  repo.commit("swallow errors", {
    "src/api/payments.ts": PAYMENTS_FEATURE,
    "src/db/orders.ts": "export const list = () => [1];\n",
  });
  store = openStore();
  dir = mkdtempSync(join(tmpdir(), "crit-pipeline-"));
});
afterEach(() => {
  store.close();
  repo.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function fake(script: FakeScriptInput) {
  return new FakeAdapter(FakeScript.parse(script), { model: null });
}

function options(
  adapter: AgentRunner,
  over: Partial<ReviewOptions> = {},
): ReviewOptions & { events: ReviewEvent[] } {
  const events: ReviewEvent[] = [];
  return {
    cwd: repo.root,
    spec: { kind: "branch", base: "main" },
    config: { ...structuredClone(DEFAULT_CONFIG), concurrency: 2 } as ResolvedConfig,
    store,
    provider: {
      profile: { name: "fake", type: "fake", command: "x", model: null, enabled: true },
      adapter,
    },
    sessionsDir: join(dir, "sessions"),
    mcpCommand: { command: "crit", args: ["mcp"] },
    home: join(dir, "home"),
    configDir: join(dir, "config"),
    onEvent: (e) => events.push(e),
    events,
    ...over,
  };
}

const reviewRun = (
  calls: { tool: string; args: Record<string, unknown> }[],
  extra: Partial<FakeRunInput> = {},
): FakeRunInput => ({
  match: { kind: "review" },
  events: [{ type: "progress", text: "reading payments.ts" }],
  calls: [...calls, { tool: "finish", args: { summary: "Checked the refund path." } }],
  ...extra,
});

describe("runReview with the fake provider", () => {
  it("runs a branch review end to end: findings, fixes, dedupe, skeptic and default checkboxes", async () => {
    const adapter = fake({
      runs: [
        reviewRun([
          { tool: "report_finding", args: refundFinding() },
          // duplicate of the first (same file, anchor, category) → merged
          {
            tool: "report_finding",
            args: refundFinding({
              severity: "major",
              confidence: 0.5,
              fix: undefined,
              ruleIds: [],
            }),
          },
          { tool: "report_finding", args: swallowFinding },
          // not in scope
          { tool: "report_finding", args: { ...swallowFinding, file: "README.md" } },
          // bad patch twice → kept without fix
          {
            tool: "report_finding",
            args: {
              ...swallowFinding,
              title: "Unused import",
              anchor: "return order;",
              range: { start: 6, end: 6 },
              fix: {
                summary: "x",
                patch:
                  "--- a/src/api/payments.ts\n+++ b/src/api/payments.ts\n@@ -1 +1 @@\n-nope\n+yes\n",
              },
            },
          },
          {
            tool: "report_finding",
            args: {
              ...swallowFinding,
              title: "Unused import",
              anchor: "return order;",
              range: { start: 6, end: 6 },
              fix: {
                summary: "x",
                patch:
                  "--- a/src/api/payments.ts\n+++ b/src/api/payments.ts\n@@ -1 +1 @@\n-nope\n+yes\n",
              },
            },
          },
        ]),
        {
          match: { kind: "skeptic" },
          skeptic: {
            default: "confirmed",
            byTitle: { "Unused import": "rejected", "Error swallowed": "plausible" },
          },
        },
      ],
    });
    const o = options(adapter);
    const result = await runReview(o);

    expect(result.review.status).toBe("completed");
    expect(result.review.scopeLabel).toBe("feature/payments → main");
    expect(result.review.summary).toBe("Checked the refund path.");
    expect(result.shards).toHaveLength(1);
    expect(result.shards[0]).toMatchObject({ status: "done", summary: "Checked the refund path." });

    const byTitle = Object.fromEntries(result.findings.map((f) => [f.title, f]));
    expect(Object.keys(byTitle).sort()).toEqual([
      "Error swallowed in catch block",
      "Refund amount not validated",
      "Unused import",
    ]);
    const refund = byTitle["Refund amount not validated"]!;
    expect(refund).toMatchObject({
      severity: "critical",
      verdict: "confirmed",
      selected: true,
      ruleIds: ["R1"],
    });
    expect(refund.mergedFrom).toHaveLength(1);
    expect(byTitle["Error swallowed in catch block"]).toMatchObject({
      verdict: "plausible",
      selected: false,
    });
    expect(byTitle["Unused import"]).toMatchObject({ verdict: "rejected", selected: false });

    const fix = await store.fixes.active(refund.id);
    expect(fix).toMatchObject({ author: "ai", summary: "Validate amount", active: true });
    expect(await store.fixes.active(byTitle["Unused import"]!.id)).toBeUndefined();

    const types = o.events.map((e) => e.type);
    expect(types.slice(0, 5)).toEqual([
      "review-started",
      "rules",
      "plan",
      "shard-started",
      "shard-progress",
    ]);
    expect(types.filter((t) => t === "finding")).toHaveLength(4);
    expect(types.filter((t) => t === "finding-rejected")).toHaveLength(2);
    expect(types.at(-1)).toBe("review-done");
    const rules = o.events.find((e) => e.type === "rules")!;
    expect(rules.type === "rules" && rules.attached.map((r) => r.id)).toEqual(["R1"]);

    // The reviewer got the rules and the diff; the skeptic got the findings block.
    const reviewTask = adapter.calls[0]!.task;
    expect(reviewTask.prompt).toContain("### R1 Validate money inputs at the boundary");
    expect(reviewTask.prompt).toContain("+  } catch (e) {}");
    expect(reviewTask.mcp?.args).toEqual(["mcp", "--session", reviewTask.mcpSession]);
    expect(adapter.calls[1]!.task.kind).toBe("skeptic");
  });

  it("re-uses the cache on an unchanged re-run and supersedes the older review", async () => {
    const script = {
      runs: [
        reviewRun([{ tool: "report_finding", args: refundFinding() }]),
        { match: { kind: "skeptic" }, skeptic: { default: "confirmed" }, repeat: true },
      ],
    } satisfies FakeScriptInput;
    const adapter = fake(script);
    const first = await runReview(options(adapter));
    const o2 = options(adapter);
    const second = await runReview(o2);
    // Every file is answered by the cache: no shards, no agent calls, verdicts kept.
    expect(second.shards).toEqual([]);
    expect(second.review.summary).toMatch(/^All 2 files are unchanged since their last review/);
    expect(adapter.calls.filter((c) => c.task.kind === "review")).toHaveLength(1);
    expect(adapter.calls.filter((c) => c.task.kind === "skeptic")).toHaveLength(1);
    expect(second.findings.map((f) => [f.fingerprint, f.verdict, f.selected])).toEqual(
      first.findings.map((f) => [f.fingerprint, f.verdict, f.selected]),
    );
    expect(await store.fixes.active(second.findings[0]!.id)).toMatchObject({ author: "ai" });
    expect(o2.events).toContainEqual({ type: "cache", files: 2, findings: 1 });
    expect((await store.reviews.get(first.review.id))?.status).toBe("superseded");

    // Edit one file: only that file is reviewed again; the other still comes from the cache.
    repo.write({ "src/api/payments.ts": `${PAYMENTS_FEATURE}// edited\n` });
    const third = await runReview(options(fake(script)));
    expect(third.shards).toHaveLength(1);
    expect(third.shards[0]).toMatchObject({ status: "done", files: ["src/api/payments.ts"] });
  });

  it("drops dismissed fingerprints and findings below the severity threshold", async () => {
    const repoRow = await store.repos.upsert({ root: repo.root, remoteUrl: null, name: "x" });
    await store.suppressions.add(
      repoRow.id,
      fingerprint({
        file: swallowFinding.file,
        anchor: swallowFinding.anchor,
        category: "correctness",
      }),
      "false-positive",
    );
    const o = options(
      fake({
        runs: [
          reviewRun([
            { tool: "report_finding", args: swallowFinding },
            {
              tool: "report_finding",
              args: { ...refundFinding(), severity: "nit", fix: undefined },
            },
          ]),
        ],
      }),
      { skeptic: null },
    );
    o.config.severityThreshold = "minor";
    const r = await runReview(o);
    expect(r.findings).toEqual([]);
  });

  it("selects confident findings with a fix when the skeptic is off", async () => {
    const r = await runReview(
      options(fake({ runs: [reviewRun([{ tool: "report_finding", args: refundFinding() }])] }), {
        skeptic: null,
      }),
    );
    expect(r.findings[0]).toMatchObject({ selected: true });
    expect(r.findings[0]!.verdict).toBeUndefined();
  });

  it("marks findings plausible when the skeptic skips them, and warns when it fails", async () => {
    const adapter = fake({
      runs: [
        reviewRun([{ tool: "report_finding", args: refundFinding() }]),
        { match: { kind: "skeptic" }, message: '{"results": []}' },
      ],
    });
    const r = await runReview(options(adapter));
    expect(r.findings[0]).toMatchObject({
      verdict: "plausible",
      verdictReason: "the skeptic gave no verdict",
      selected: false,
    });

    const bad = fake({
      runs: [
        reviewRun([{ tool: "report_finding", args: refundFinding() }]),
        { match: { kind: "skeptic" }, message: "I think they are fine." },
        { match: { kind: "skeptic" }, message: "still prose" },
      ],
    });
    const o = options(bad, { useCache: false });
    const r2 = await runReview(o);
    expect(r2.findings[0]!.verdict).toBeUndefined();
    expect(
      o.events.some((e) => e.type === "warning" && /skeptic pass failed/.test(e.message)),
    ).toBe(true);
    expect(bad.calls.filter((c) => c.task.kind === "skeptic")).toHaveLength(2);
    expect(bad.calls[2]!.task.prompt).toContain("could not be used");
  });

  it("uses the JSON fallback, with one repair round, when the agent has no MCP", async () => {
    const inner = fake({
      runs: [
        { match: { kind: "review" }, message: "Sorry, here is prose" },
        {
          match: { kind: "review" },
          message: JSON.stringify({
            findings: [refundFinding({ fix: undefined }), { file: "x" }],
            summary: "json summary",
          }),
        },
      ],
    });
    const noMcp: AgentRunner = {
      capabilities: { mcp: false, nativeContext: [] },
      run: (t, s) => inner.run(t, s),
    };
    const o = options(noMcp, { skeptic: null });
    const r = await runReview(o);
    expect(r.findings.map((f) => f.title)).toEqual(["Refund amount not validated"]);
    expect(r.review.summary).toBe("json summary");
    expect(inner.calls[0]!.task.mcpSession).toBeUndefined();
    expect(inner.calls[0]!.task.systemPrompt).toContain("reply with ONLY a JSON object");
    expect(o.events.filter((e) => e.type === "finding-rejected")).toHaveLength(1);
  });

  it("retries after a rate limit and fails the review when every shard fails", async () => {
    let n = 0;
    const flaky: AgentRunner = {
      capabilities: { mcp: false, nativeContext: [] },
      async *run(): AsyncIterable<AgentEvent> {
        n++;
        if (n === 1) {
          yield { type: "rate-limited", retryAfterMs: 1 };
          yield { type: "done", exitCode: 1 };
          return;
        }
        yield { type: "message", text: '{"findings": [], "summary": "clean"}' };
        yield { type: "done", exitCode: 0 };
      },
    };
    const o = options(flaky, { skeptic: null, maxRateLimitWaitMs: 5 });
    const r = await runReview(o);
    expect(r.review.status).toBe("completed");
    expect(o.events.some((e) => e.type === "rate-limited")).toBe(true);

    const broken: AgentRunner = {
      capabilities: { mcp: true, nativeContext: [] },
      async *run() {
        yield { type: "error", message: "not logged in" } as AgentEvent;
        yield { type: "done", exitCode: 1 } as AgentEvent;
      },
    };
    const o2 = options(broken, { useCache: false });
    await expect(runReview(o2)).rejects.toThrow(/every shard failed: not logged in/);
    const failed = o2.events.find((e) => e.type === "review-failed")!;
    expect(
      failed.type === "review-failed" && (await store.reviews.get(failed.reviewId))?.status,
    ).toBe("failed");
  });

  it("gives up on a long rate limit and records the shard error", async () => {
    const limited: AgentRunner = {
      capabilities: { mcp: false, nativeContext: [] },
      async *run() {
        yield { type: "rate-limited", retryAfterMs: 10 * 60_000 } as AgentEvent;
        yield { type: "done", exitCode: 1 } as AgentEvent;
      },
    };
    const r = await runReview(options(limited, { maxRateLimitWaitMs: 5 }));
    expect(r.review.status).toBe("partial");
    expect(r.review.summary).toMatch(/rate limited, after 0 of 1 runs/);
    expect(r.shards[0]).toMatchObject({
      status: "failed",
      error: "rate limited; re-run to resume",
    });
  });

  it("stops the whole queue on a rate limit; queued shards stay queued", async () => {
    let calls = 0;
    const limited: AgentRunner = {
      capabilities: { mcp: false, nativeContext: [] },
      async *run() {
        calls++;
        yield { type: "rate-limited", retryAfterMs: 10 * 60_000 } as AgentEvent;
        yield { type: "done", exitCode: 1 } as AgentEvent;
      },
    };
    const o = options(limited, { maxRateLimitWaitMs: 5, skeptic: null });
    o.config.shardTokens = 5;
    o.config.concurrency = 1;
    const r = await runReview(o);
    // a wait longer than maxRateLimitWaitMs is not retried, and no further shard starts
    expect(calls).toBe(1);
    expect(r.shards.map((s) => s.status)).toEqual(["failed", "queued"]);
    expect(r.review.status).toBe("partial");
    expect(o.events.find((e) => e.type === "review-done")).toMatchObject({
      partial: expect.stringContaining("run again later to resume"),
    });
  });

  it("stops at the token budget: in-flight work is aborted and queued shards stay queued", async () => {
    const adapter = fake({
      runs: [
        {
          ...reviewRun([
            { tool: "report_finding", args: refundFinding({ fix: undefined, ruleIds: [] }) },
          ]),
          events: [
            {
              type: "usage",
              partial: true,
              inputTokens: 5000,
              outputTokens: 0,
              cachedInputTokens: 0,
            },
          ],
          repeat: true,
        },
      ],
    });
    const o = options(adapter, { skeptic: null });
    o.config.shardTokens = 5;
    o.config.concurrency = 1;
    o.config.budget.maxTokens = 1000;
    const r = await runReview(o);
    expect(r.review.status).toBe("partial");
    expect(r.review.summary).toMatch(/Stopped at the 1,000-token budget after 0 of 2 runs/);
    expect(r.shards.map((s) => [s.status, s.error])).toEqual([
      ["cancelled", "stopped: token budget reached"],
      ["queued", null],
    ]);
    expect(o.events).toContainEqual({ type: "budget-stop", spent: 5000, limit: 1000 });
    expect(adapter.calls.filter((c) => c.task.kind === "review")).toHaveLength(1);
  });

  it("records fresh, cached and output tokens, reports effective spend, and calibrates the cost ratio", async () => {
    const metered: AgentRunner = {
      capabilities: { mcp: false, nativeContext: [] },
      async *run(): AsyncIterable<AgentEvent> {
        yield {
          type: "usage",
          partial: true,
          inputTokens: 500,
          outputTokens: 10,
          cachedInputTokens: 4000,
        };
        yield { type: "message", text: '{"findings": [], "summary": "ok"}' };
        yield { type: "usage", inputTokens: 1000, outputTokens: 50, cachedInputTokens: 9000 };
        yield { type: "done", exitCode: 0 };
      },
    };
    const o = options(metered, { skeptic: null });
    const r = await runReview(o);
    expect(r.shards[0]).toMatchObject({ inputTokens: 1000, cachedTokens: 9000, outputTokens: 50 });
    const spent = o.events
      .filter((e) => e.type === "usage")
      .map((e) => (e as { spent: number }).spent);
    expect(spent).toEqual([910, 1950]); // running figure, then the final one
    const ratio = Number(await store.kv.get("cost-ratio:fake"));
    expect(ratio).toBeCloseTo((3 + 1950 / r.shards[0]!.estimatedTokens) / 2, 1);
  });

  it("treats an agent that never calls crit's tools as a failure, not as 'no findings'", async () => {
    const adapter = fake({ runs: [{ match: { kind: "review" }, message: "Looks fine to me." }] });
    const o = options(adapter, { skeptic: null });
    await expect(runReview(o)).rejects.toThrow(
      /every shard failed: the agent never called crit's tools/,
    );
    expect(
      o.events.some((e) => e.type === "warning" && /without calling crit's tools/.test(e.message)),
    ).toBe(true);
    const prep = await prepareReview(options(adapter));
    expect(prep.cached.size).toBe(0);
  });

  it("previews a review: runs, the cache, and an effective-token estimate that learns from past runs", async () => {
    const adapter = fake({ runs: [{ ...reviewRun([]), repeat: true }] });
    const before = await prepareReview(options(adapter));
    expect(before.runs).toHaveLength(1);
    expect(before.ratio).toBe(3);
    expect(before.estimatedTokens).toBe(Math.round(before.runs[0]!.estimatedTokens * 3));
    expect(before.toReview.files.map((f) => f.path)).toEqual([
      "src/api/payments.ts",
      "src/db/orders.ts",
    ]);
    await runReview(options(adapter, { skeptic: null }));
    const after = await prepareReview(options(adapter));
    expect(after.cached.size).toBe(2);
    expect(after.runs).toEqual([]);
    expect(after.estimatedTokens).toBe(0);
    expect(after.scope.files).toHaveLength(2);
  });

  it("passes the plan with its token estimate to confirm", async () => {
    const adapter = fake({ runs: [{ ...reviewRun([]), repeat: true }] });
    let seen: { estimatedTokens: number; cachedFiles: number } | undefined;
    await runReview(
      options(adapter, {
        skeptic: null,
        confirm: async (plan) => {
          seen = { estimatedTokens: plan.estimatedTokens, cachedFiles: plan.cachedFiles };
          return true;
        },
      }),
    );
    expect(seen).toEqual({ estimatedTokens: expect.any(Number), cachedFiles: 0 });
    expect(seen!.estimatedTokens).toBeGreaterThan(0);
  });

  it("reviews the whole project with a cached map pass and asks for confirmation", async () => {
    const adapter = fake({
      runs: [
        { match: { kind: "map" }, message: "A tiny shop with an API and a DB layer." },
        { ...reviewRun([]), repeat: true },
      ],
    });
    const o = options(adapter, {
      spec: { kind: "project" },
      skeptic: null,
      useCache: false,
      confirm: async (plan) => plan.shards.length === 1,
    });
    const r = await runReview(o);
    expect(r.review.status).toBe("completed");
    expect(adapter.calls[1]!.task.prompt).toContain("Repository overview:\nA tiny shop");
    expect(adapter.calls[1]!.task.prompt).toContain("The files under review:");
    expect(adapter.calls[1]!.task.prompt).toMatch(
      /### src\/api\/payments\.ts\n```\n1 {2}export async function refund/,
    );
    await runReview(o);
    expect(adapter.calls.filter((c) => c.task.kind === "map")).toHaveLength(1);

    const no = options(adapter, { spec: { kind: "project" }, confirm: async () => false });
    await expect(runReview(no)).rejects.toThrow(/cancelled/);
    const failed = no.events.find((e) => e.type === "review-failed")!;
    expect(
      failed.type === "review-failed" && (await store.reviews.get(failed.reviewId))?.status,
    ).toBe("cancelled");
  });

  it("warns when the map pass fails and enforces the shard budget", async () => {
    const adapter = fake({
      runs: [
        { match: { kind: "map" }, exitCode: 1 },
        { ...reviewRun([]), repeat: true },
      ],
    });
    const o = options(adapter, { spec: { kind: "project" }, skeptic: null });
    await runReview(o);
    expect(
      o.events.some((e) => e.type === "warning" && /repo map pass failed/.test(e.message)),
    ).toBe(true);

    const tight = options(adapter, { spec: { kind: "project" }, useCache: false });
    tight.config.budget.maxShards = 1;
    tight.config.shardTokens = 5;
    await expect(runReview(tight)).rejects.toThrow(/exceed budget.maxShards \(1\)/);
  });

  it("completes immediately when there is nothing to review, and honours cancellation", async () => {
    repo.git("checkout", "-q", "main");
    repo.git("checkout", "-q", "-b", "empty");
    const r = await runReview(options(fake({ runs: [] })));
    expect(r.review).toMatchObject({
      status: "completed",
      summary: "Nothing to review in this scope.",
    });

    repo.git("checkout", "-q", "feature/payments");
    const ac = new AbortController();
    const slow = fake({ runs: [{ ...reviewRun([]), delayMs: 5000 }] });
    const o = options(slow, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(runReview(o)).rejects.toThrow(/cancelled/);
  });

  it("passes model and allowed commands to the agent, and exposes rules over MCP", async () => {
    const seen: AgentTask[] = [];
    const adapter = fake({
      runs: [
        reviewRun([
          { tool: "get_rules", args: { ids: ["R1"] } },
          { tool: "get_scope", args: {} },
        ]),
      ],
    });
    const spy: AgentRunner = {
      capabilities: adapter.capabilities,
      run: (t, s) => (seen.push(t), adapter.run(t, s)),
    };
    const o = options(spy, { skeptic: null });
    o.provider.profile.model = "fake-large";
    o.config.review.allowedCommands = ["pnpm typecheck"];
    const r = await runReview(o);
    expect(seen[0]).toMatchObject({ model: "fake-large", allowedCommands: ["pnpm typecheck"] });
    expect(r.findings).toEqual([]);
    const progress = o.events
      .filter((e) => e.type === "shard-progress")
      .map((e) => (e as { text: string }).text);
    expect(progress.some((t) => t.startsWith("get_rules: ## R1 Validate money"))).toBe(true);
    expect(progress.some((t) => t.startsWith("get_scope: {"))).toBe(true);
  });
});

describe("Intake", () => {
  const intakeFor = async (
    spec: Parameters<typeof resolveScope>[0]["spec"] = { kind: "branch", base: "main" },
  ) =>
    new Intake({
      scope: await resolveScope({ cwd: repo.root, spec }),
      ruleIds: new Set(["R1"]),
      suppressed: new Set(),
    });
  const base = refundFinding({ fix: undefined, ruleIds: [] }) as FindingInput;

  it("normalizes paths and re-anchors ranges", async () => {
    const i = await intakeFor();
    const r = await i.check({
      ...base,
      file: "./src/api/payments.ts",
      range: { start: 2, end: 2 },
    });
    expect(r).toMatchObject({
      accepted: true,
      finding: { file: "src/api/payments.ts", range: { start: 4, end: 4 } },
    });
    expect(r.accepted && r.warnings[0]).toMatch(/range moved from 2-2 to 4-4/);
    const abs = await i.check({ ...base, file: join(repo.root, "src/api/payments.ts") });
    expect(abs.accepted).toBe(true);
    const long = await i.check({ ...base, range: { start: 4, end: 99 } });
    expect(long.accepted && long.finding.range).toEqual({ start: 4, end: 7 });
  });

  it("rejects out-of-scope files, ranges past the end, missing anchors and unchanged lines", async () => {
    const i = await intakeFor();
    const err = async (f: Partial<FindingInput>) => {
      const r = await i.check({ ...base, ...f });
      return r.accepted ? [] : r.errors;
    };
    expect((await err({ file: "README.md" }))[0]).toMatch(/not in this review's scope/);
    expect((await err({ range: { start: 50, end: 51 } }))[0]).toMatch(
      /past the end of src\/api\/payments.ts \(7 lines\)/,
    );
    expect((await err({ anchor: "not in the file" }))[0]).toMatch(/anchor: not found/);
    expect(
      (await err({ range: { start: 1, end: 1 }, anchor: "export async function refund" }))[0],
    ).toBeUndefined();

    // A long file on main where the branch only changes the last line.
    repo.git("checkout", "-q", "main");
    const long = Array.from({ length: 30 }, (_, n) => `export const v${n + 1} = ${n + 1};`).join(
      "\n",
    );
    repo.commit("long", { "src/db/long.ts": `${long}\n` });
    repo.git("checkout", "-q", "feature/payments");
    repo.git("merge", "-q", "--no-edit", "main");
    repo.commit("edit end", { "src/db/long.ts": `${long.replace("v30 = 30", "v30 = 31")}\n` });
    const j = await intakeFor();
    const far = await j.check({
      ...base,
      file: "src/db/long.ts",
      range: { start: 2, end: 2 },
      anchor: "export const v2 = 2;",
    });
    expect(!far.accepted && far.errors[0]).toBe(
      "range: lines 2-2 are outside the changed lines of src/db/long.ts (changed: 27-30). Report on the changed lines that cause the problem.",
    );
    const near = await j.check({
      ...base,
      file: "src/db/long.ts",
      range: { start: 25, end: 25 },
      anchor: "export const v25 = 25;",
    });
    expect(near.accepted).toBe(true);
  });

  it("reads files at the reviewed commit", async () => {
    const sha = repo.git("rev-parse", "HEAD");
    repo.write({ "src/api/payments.ts": "totally different\n" });
    const i = await intakeFor({ kind: "commit", sha });
    expect((await i.check(base)).accepted).toBe(true);
    repo.git("add", "-A");
    const s = await intakeFor({ kind: "staged" });
    expect(
      (await s.check({ ...base, anchor: "totally different", range: { start: 1, end: 1 } }))
        .accepted,
    ).toBe(true);
  });

  it("returns a missing file as unreadable", async () => {
    const i = await intakeFor();
    repo.remove("src/api/payments.ts");
    const r = await i.check(base);
    expect(!r.accepted && r.errors[0]).toMatch(/could not be read/);
  });
});

describe("reanchorFindings", () => {
  it("moves findings to their anchor and closes ones whose code is gone", async () => {
    const r = await runReview(
      options(
        fake({
          runs: [
            reviewRun([
              { tool: "report_finding", args: refundFinding({ fix: undefined }) },
              { tool: "report_finding", args: swallowFinding },
            ]),
          ],
        }),
        { skeptic: null },
      ),
    );
    repo.write({
      "src/api/payments.ts": `// header\n${PAYMENTS_FEATURE.replace("  } catch (e) {}\n", "  } finally {}\n")}`,
    });
    const scope = await resolveScope({ cwd: repo.root, spec: { kind: "branch", base: "main" } });
    expect(await reanchorFindings(store, scope, r.findings)).toEqual({ moved: 1, closed: 1 });
    const after = await store.findings.listByReview(r.review.id);
    expect(after.find((f) => f.title.startsWith("Refund"))!.range).toEqual({ start: 5, end: 5 });
    expect(after.find((f) => f.title.startsWith("Error"))!.status).toBe("closed");
    expect(await reanchorFindings(store, scope, after)).toEqual({ moved: 0, closed: 0 });
  });
});
