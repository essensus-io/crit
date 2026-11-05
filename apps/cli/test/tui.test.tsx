import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FixContext } from "@crit/core";
import { FakeAdapter, FakeScript, type FakeScriptInput } from "@crit/providers";
import { DEFAULT_CONFIG, type Finding, newId, type ReviewEvent, type Shard } from "@crit/schema";
import { openStore, type SqliteStore } from "@crit/store";
import { createFixtureRepo, type FixtureRepo } from "@crit/testkit";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReviewApp, RunApp } from "../src/tui/App.tsx";
import { emptyProgress, reduceProgress } from "../src/tui/ProgressScreen.tsx";
import { type Editor, ReviewSession } from "../src/tui/session.ts";

const CODE = `export async function refund(order, amount, provider) {
  if (amount > order.capturedAmount) {
    throw new HttpError(422, "too large");
  }
  await provider.refund(order.chargeId, amount);
}
import { unused } from "./x";
`;
const AI_PATCH = `--- a/src/payments.ts
+++ b/src/payments.ts
@@ -1,4 +1,4 @@
 export async function refund(order, amount, provider) {
-  if (amount > order.capturedAmount) {
+  if (amount <= 0 || amount > order.capturedAmount - order.refundedAmount) {
     throw new HttpError(422, "too large");
   }
`;
const USER_PATCH = AI_PATCH.replace(
  "amount <= 0 || amount > order.capturedAmount - order.refundedAmount",
  "amount > order.capturedAmount || amount <= 0",
);

let repo: FixtureRepo;
let store: SqliteStore;
let backups: string;
let reviewId: string;
const ids: Record<string, string> = {};

async function seed() {
  const r = await store.repos.upsert({ root: repo.root, remoteUrl: null, name: "shop" });
  reviewId = newId();
  await store.reviews.create({
    id: reviewId,
    repoId: r.id,
    scope: { kind: "branch", base: "main" },
    scopeLabel: "feature/payments → main",
    branch: "feature/payments",
    baseSha: null,
    headSha: null,
    provider: "claude",
    model: "opus",
    lenses: ["correctness"],
    status: "completed",
    supersededBy: null,
    summary: null,
    rulesHeader: null,
    startedAt: Date.now(),
    finishedAt: Date.now(),
  });
  await store.events.append(reviewId, "rules", {
    rules: [
      {
        id: "R4",
        title: "Validate money inputs at the boundary",
        path: ".cursor/rules/payments.mdc",
      },
    ],
  });
  const add = async (key: string, over: Partial<Finding>, patch?: string) => {
    const f: Finding = {
      id: newId(),
      reviewId,
      fingerprint: `fp-${key}`,
      file: "src/payments.ts",
      range: { start: 2, end: 2 },
      anchor: "if (amount > order.capturedAmount) {",
      severity: "critical",
      category: "correctness",
      title: key,
      explanation: "refund() takes any amount from the request body.",
      confidence: 0.92,
      ruleIds: [],
      status: "open",
      selected: false,
      mergedFrom: [],
      createdAt: Date.now(),
      ...over,
    };
    await store.findings.create(f);
    if (patch)
      await store.fixes.create({
        id: newId(),
        findingId: f.id,
        author: "ai",
        patch,
        summary: "Validate against captured minus refunded",
        overridden: false,
        active: true,
        createdAt: Date.now(),
      });
    ids[key] = f.id;
  };
  await add(
    "Refund amount not validated",
    {
      selected: true,
      verdict: "confirmed",
      failureScenario: "POST /refunds {orderId: 17, amount: 5000} on a 2000 capture",
      ruleIds: ["R4"],
    },
    AI_PATCH,
  );
  await add("Unused import", {
    severity: "nit",
    category: "style",
    range: { start: 7, end: 7 },
    anchor: 'import { unused } from "./x";',
    verdict: "plausible",
  });
  await add("Invented problem", {
    severity: "major",
    range: { start: 5, end: 5 },
    anchor: "await provider.refund(order.chargeId, amount);",
    verdict: "rejected",
    verdictReason: "already handled upstream",
  });
}

beforeEach(async () => {
  repo = createFixtureRepo({ "src/payments.ts": CODE });
  store = openStore();
  backups = mkdtempSync(join(tmpdir(), "crit-tui-"));
  await seed();
});
afterEach(() => {
  store.close();
  repo.cleanup();
  rmSync(backups, { recursive: true, force: true });
});

function session(script: FakeScriptInput = { runs: [] }, editor: Editor = async () => undefined) {
  const fake = new FakeAdapter(FakeScript.parse(script), { model: null });
  const fixContext: FixContext = {
    store,
    provider: {
      profile: { name: "f", type: "fake", command: "x", model: null, enabled: true },
      adapter: fake,
    },
    root: repo.root,
    config: { review: DEFAULT_CONFIG.review, verify: { commands: [] } },
    read: async (p) => readFileSync(join(repo.root, p), "utf8"),
  };
  return new ReviewSession({
    store,
    root: repo.root,
    reviewId,
    fixContext,
    editor,
    backupRoot: backups,
    verifyCommands: [],
  });
}

const sleep = (ms = 25) => new Promise((r) => setTimeout(r, ms));
async function until(frame: () => string | undefined, text: string | RegExp, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const f = frame() ?? "";
    if (typeof text === "string" ? f.includes(text) : text.test(f)) return f;
    await sleep(15);
  }
  throw new Error(`timed out waiting for ${String(text)} in:\n${frame()}`);
}
const ENTER = "\r";
const ESC = "\u001B";
const TAB = "\t";

async function mount(s: ReviewSession) {
  await s.load();
  const app = render(<ReviewApp session={s} />);
  await until(app.lastFrame, "FINDINGS");
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      app.stdin.write(k);
      await sleep(k === ESC ? 60 : 25);
    }
  };
  return { ...app, press };
}

describe("findings list", () => {
  it("shows files, findings with checkbox, severity, location and title, and the filtered count", async () => {
    const app = await mount(session());
    const f = app.lastFrame()!;
    expect(f).toContain("crit · review");
    expect(f).toContain("feature/payments → main · claude (opus) · 2 findings · 1 selected");
    expect(f).toMatch(/\[x\] CRIT payments\.ts:2\s+Refund amount not validated/);
    expect(f).toMatch(/\[ \] NIT  payments\.ts:7\s+Unused import/);
    expect(f).toContain("Filtered (1)");
    expect(f).toContain("▾ src");
    expect(f).toContain("a apply 1");
    app.unmount();
  });

  it("moves, toggles selection, filters by severity, searches and shows the filtered tab", async () => {
    const app = await mount(session());
    await app.press("j", " ");
    await until(app.lastFrame, "This finding has no fix to apply");
    await app.press("k", " ");
    await until(app.lastFrame, "0 selected");
    expect((await store.findings.get(ids["Refund amount not validated"]!))!.selected).toBe(false);
    await app.press(" ");
    await until(app.lastFrame, "1 selected");

    await app.press("s");
    expect(app.lastFrame()).toContain("critical+");
    expect(app.lastFrame()).not.toContain("Unused import");
    await app.press("s", "s", "s");
    expect(app.lastFrame()).toContain("all severities");

    await app.press("/", "u", "n", "u", "s", "e", "d", ENTER);
    await until(app.lastFrame, "/unused");
    expect(app.lastFrame()).not.toContain("Refund amount not validated  ");
    await app.press("/", "\u007F", "\u007F", "\u007F", "\u007F", "\u007F", "\u007F", ENTER);

    await app.press(TAB);
    await until(app.lastFrame, "FILTERED BY SKEPTIC / DISMISSED");
    expect(app.lastFrame()).toMatch(/\[-\] MAJ\s+payments\.ts:5\s+Invented problem/);
    await app.press(TAB, "q");
    app.unmount();
  });

  it("filters by file from the files pane", async () => {
    const app = await mount(session());
    await app.press("h", "j", "j", ENTER);
    await until(app.lastFrame, "2 findings");
    expect(app.lastFrame()).toContain("Unused import");
    app.unmount();
  });

  it("dismisses with a reason, remembers false positives, and restores from the filtered tab", async () => {
    const app = await mount(session());
    await app.press("j", "d");
    await until(app.lastFrame, "Dismiss:");
    await app.press("f");
    await until(app.lastFrame, "1 findings");
    const repoId = (await store.reviews.get(reviewId))!.repoId;
    expect((await store.suppressions.list(repoId)).map((s) => s.fingerprint)).toEqual([
      "fp-Unused import",
    ]);
    await app.press(TAB);
    await until(app.lastFrame, /\[d\] NIT/);
    const lines = app.lastFrame()!.split("\n");
    const row = lines.findIndex((l) => l.includes("Unused import"));
    const first = lines.findIndex((l) => l.includes("Invented problem"));
    await app.press(...(row > first ? ["j"] : []), "d");
    await until(app.lastFrame, "Filtered (1)");
    expect(await store.suppressions.list(repoId)).toEqual([]);
    app.unmount();
  });

  it("applies checked fixes from the list", async () => {
    const app = await mount(session());
    await app.press("a");
    await until(app.lastFrame, "Apply 1 checked fix:");
    await app.press("y");
    await until(app.lastFrame, "Applied 1 · crit undo restores the files");
    expect(readFileSync(join(repo.root, "src/payments.ts"), "utf8")).toContain(
      "order.refundedAmount",
    );
    app.unmount();
  });
});

describe("finding detail", () => {
  it("shows what is wrong, how it fails, the rule and the fix diff; tabs and navigation work", async () => {
    const app = await mount(session());
    await app.press(ENTER);
    const f = await until(app.lastFrame, "Thread (0)");
    expect(f).toContain("src/payments.ts:2 · CRITICAL · correctness · confidence 0.92 · confirmed");
    expect(f).toContain("[x] include");
    expect(f).toContain("Fails when  POST /refunds {orderId: 17, amount: 5000} on a 2000 capture");
    expect(f).toContain(
      "Rule        R4 Validate money inputs at the boundary  (.cursor/rules/payments.mdc)",
    );
    expect(f).toContain("[ AI ● ] [ yours – ]");
    expect(f).toMatch(/2  - {3}if \(amount > order\.capturedAmount\) \{/);
    expect(f).toMatch(/2  \+ {3}if \(amount <= 0/);
    await app.press(TAB);
    await until(app.lastFrame, "No fix of yours yet");
    await app.press("n");
    await until(app.lastFrame, "Unused import");
    expect(app.lastFrame()).toContain("2/2");
    await app.press("N", ESC);
    await until(app.lastFrame, "FINDINGS");
    app.unmount();
  });

  it("asks a question and shows the answer in the thread", async () => {
    const app = await mount(
      session({
        runs: [{ match: { kind: "answer" }, message: "Yes, on a second partial refund." }],
      }),
    );
    await app.press(ENTER, "?");
    await until(app.lastFrame, "Ask ›");
    await app.press(..."why?".split(""), ENTER);
    await until(app.lastFrame, "Thread (2)");
    expect(app.lastFrame()).toContain("you why?");
    expect(app.lastFrame()).toContain("AI  Yes, on a second partial refund.");
    app.unmount();
  });

  it("edits the AI fix in the editor and keeps the edit as your fix", async () => {
    let seen = "";
    const editor: Editor = async (content) => {
      seen = content;
      return content.replace('"too large"', '"refund exceeds captured amount"');
    };
    const app = await mount(session({ runs: [] }, editor));
    await app.press(ENTER, "e");
    await until(app.lastFrame, "[ yours ● ]");
    expect(seen).toContain("order.refundedAmount");
    const active = await store.fixes.active(ids["Refund amount not validated"]!);
    expect(active).toMatchObject({ author: "user", summary: "Edited fix" });
    app.unmount();
  });
});

describe("proposing a better fix", () => {
  it("concerns → answer → accepted, ending with your fix active", async () => {
    const app = await mount(
      session({
        runs: [
          { match: { kind: "draft-fix" }, message: `\`\`\`diff\n${USER_PATCH}\`\`\`` },
          {
            match: { kind: "evaluate-fix" },
            message: JSON.stringify({
              verdict: "concerns",
              reason: "This ignores earlier partial refunds.",
              question: "Can an order have more than one refund?",
            }),
          },
          {
            match: { kind: "evaluate-fix" },
            message: JSON.stringify({
              verdict: "accepted",
              reason: "With single refunds only, your fix is enough.",
            }),
          },
        ],
      }),
    );
    await app.press("p");
    await until(app.lastFrame, "Propose a fix:");
    await app.press("w");
    await app.press(..."reject zero too".split(""), ENTER);
    const f = await until(app.lastFrame, "CONCERNS");
    expect(f).toContain("Your fix · not applied · CONCERNS");
    expect(f).toContain("Drafted from your description:");
    expect(f).toContain("AI  This ignores earlier partial refunds.");
    expect(f).toContain("Can an order have more than one refund?");
    expect(f).toContain("enter reply · u use anyway · k keep AI fix · esc back");
    await app.press(ENTER);
    await until(app.lastFrame, "you ›");
    await app.press(..."No, one refund only".split(""), ENTER);
    await until(app.lastFrame, "ACCEPTED");
    expect(app.lastFrame()).toContain("Your fix · checked · ACCEPTED");
    await app.press(ESC);
    await until(app.lastFrame, "[ yours ● ]");
    app.unmount();
  });

  it("rejected → use anyway; and keep AI fix", async () => {
    const editor: Editor = async (content) =>
      content.replace(
        "if (amount > order.capturedAmount) {",
        "if (amount > order.capturedAmount || amount <= 0) {",
      );
    const app = await mount(
      session(
        {
          runs: [
            {
              match: { kind: "evaluate-fix" },
              message: JSON.stringify({
                verdict: "rejected",
                reason: "Still allows two partial refunds.",
                failingCase: "1500 + 1500 on 2000",
              }),
            },
          ],
        },
        editor,
      ),
    );
    await app.press(ENTER, "p", "e");
    const f = await until(app.lastFrame, "REJECTED");
    expect(f).toContain("Fails when: 1500 + 1500 on 2000");
    await app.press("u");
    await until(app.lastFrame, "[ yours ● ]");
    expect(await store.fixes.active(ids["Refund amount not validated"]!)).toMatchObject({
      author: "user",
      overridden: true,
    });
    await app.press("k");
    await until(app.lastFrame, "[ AI ● ]");
    app.unmount();
  });

  it("shows errors from failed actions", async () => {
    const app = await mount(
      session({ runs: [{ match: { kind: "draft-fix" }, message: "no diff here" }] }),
    );
    await app.press("p", "w", "x", ENTER);
    const frame = await until(
      app.lastFrame,
      "✗ the agent could not turn your description into a patch",
    );
    expect(frame).toContain("FINDINGS");
    app.unmount();
  });
});

describe("run progress", () => {
  it.each(["budget", "provider"])("offers %s recovery after a limit", async (kind) => {
    let emit: (e: ReviewEvent) => void = () => {};
    let recovery: unknown;
    const app = render(
      <RunApp
        subscribe={(fn) => {
          emit = fn;
          return () => {};
        }}
        makeSession={async () => {
          throw new Error("should stay on progress");
        }}
        onStop={() => {}}
        onRecover={(action) => {
          recovery = action;
        }}
      />,
    );
    await sleep();
    if (kind === "budget") {
      emit({ type: "budget-exceeded", required: 134, limit: 40 });
      emit({ type: "review-failed", reviewId: "r", error: "budget exceeded" });
      await until(app.lastFrame, "134 shards");
      app.stdin.write("b");
    } else {
      emit({ type: "rate-limited", shardId: "a", retryAfterMs: 30000 });
      emit({ type: "review-done", reviewId: "r", findings: [], durationMs: 1 });
      await until(app.lastFrame, "Provider rate limited");
      app.stdin.write("p");
    }
    await sleep();
    expect(recovery).toEqual(kind === "budget" ? { kind, maxShards: 134 } : { kind });
    app.unmount();
  });

  const shard = (id: string, label: string): Shard => ({
    id,
    reviewId: "r",
    label,
    files: [],
    lenses: ["correctness", "security"],
    status: "queued",
    estimatedTokens: 1,
    inputTokens: null,
    cachedTokens: null,
    outputTokens: null,
    durationMs: null,
    agentSessionId: null,
    summary: null,
    error: null,
  });

  it("folds events into shard rows and the rules line", () => {
    let p = emptyProgress();
    const events: ReviewEvent[] = [
      {
        type: "rules",
        attached: [{ id: "R1", title: "Errors", path: "CLAUDE.md", section: "Errors" }],
        listed: [{ id: "R2", title: "x", path: "y" }],
        conflicts: [{ topic: "t", ruleIds: [] }],
      },
      { type: "plan", shards: [shard("a", "src/api"), shard("b", "src/db")], estimateMs: 1000 },
      { type: "shard-started", shardId: "a" },
      { type: "shard-progress", shardId: "a", text: "reading orders.ts" },
      {
        type: "shard-done",
        shard: { ...shard("a", "src/api"), status: "done", durationMs: 102_000 },
      },
      {
        type: "shard-done",
        shard: { ...shard("b", "src/db"), status: "failed", error: "not logged in" },
      },
      { type: "verify-started", count: 3 },
      { type: "warning", message: "careful" },
      { type: "review-failed", reviewId: "r", error: "boom" },
    ];
    for (const e of events) p = reduceProgress(p, e);
    expect(p.rules).toEqual({ attached: ["CLAUDE.md §Errors"], listed: 1, conflicts: 1 });
    expect(p.shards.get("a")).toMatchObject({
      status: "done",
      text: "reading orders.ts",
      durationMs: 102_000,
    });
    expect(p.shards.get("b")).toMatchObject({ status: "failed", text: "not logged in" });
    expect(p).toMatchObject({ verifying: 3, warnings: ["careful"], done: true, failed: "boom" });
  });

  it("shows progress, then opens the findings so far with enter", async () => {
    let emit: (e: ReviewEvent) => void = () => {};
    let stopped = false;
    const s = session();
    const app = render(
      <RunApp
        subscribe={(fn) => {
          emit = fn;
          return () => {};
        }}
        makeSession={async () => {
          await s.load();
          return s;
        }}
        onStop={() => (stopped = true)}
      />,
    );
    await sleep();
    emit({
      type: "review-started",
      reviewId,
      scope: { label: "feature → main" } as never,
      provider: "claude",
      model: "sonnet",
    });
    emit({
      type: "rules",
      attached: [{ id: "R1", title: "Errors", path: "CLAUDE.md", section: "Errors" }],
      listed: [],
      conflicts: [],
    });
    emit({ type: "plan", shards: [shard("a", "src/api")], estimateMs: 1000 });
    emit({ type: "shard-started", shardId: "a" });
    emit({ type: "shard-progress", shardId: "a", text: "reading Cart.tsx …" });
    const f = await until(app.lastFrame, "reading Cart.tsx");
    expect(f).toContain("crit review · feature → main · claude (sonnet) · 1 shard");
    expect(f).toContain("Rules  1 attached: CLAUDE.md §Errors");
    expect(f).toContain("q stop · enter open findings so far");
    app.stdin.write("q");
    await sleep();
    expect(stopped).toBe(true);
    app.stdin.write(ENTER);
    await until(app.lastFrame, "FINDINGS");
    app.unmount();
  });
});
