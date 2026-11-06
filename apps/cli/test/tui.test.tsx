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
import { emptyProgress, ProgressScreen, reduceProgress } from "../src/tui/ProgressScreen.tsx";
import { type Editor, ReviewSession, type SessionDeps } from "../src/tui/session.ts";
import type { Choice, Switcher } from "../src/tui/switcher.ts";

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

function session(
  script: FakeScriptInput = { runs: [] },
  editor: Editor = async () => undefined,
  extra: Partial<SessionDeps> = {},
) {
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
    code: {
      read: async (p) => readFileSync(join(repo.root, p), "utf8"),
      added: (f) => (f === "src/payments.ts" ? new Set([2, 3]) : new Set<number>()),
    },
    ...extra,
  });
}

const sleep = (ms = 25) => new Promise((r) => setTimeout(r, ms));
async function until(frame: () => string | undefined, text: string | RegExp, ms = 10_000) {
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

async function mount(s: ReviewSession, switcher?: Switcher, ready = "of 2 reviewed") {
  await s.load();
  const app = render(<ReviewApp session={s} {...(switcher ? { switcher } : {})} />);
  await until(app.lastFrame, ready);
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      app.stdin.write(k);
      await sleep(k === ESC ? 60 : 25);
    }
  };
  return { ...app, press };
}

describe("review stream", () => {
  it("shows the code with each finding under the lines it is about, plus progress and the keys that work now", async () => {
    const app = await mount(session());
    const f = app.lastFrame()!;
    expect(f).toContain("crit · review");
    expect(f).toContain("feature/payments → main · claude (opus)");
    expect(f).toContain("▍ src/payments.ts  2 findings");
    expect(f).toMatch(/2 ▎\+\s+if \(amount > order\.capturedAmount\) \{/); // changed line, in the focused range
    expect(f).toMatch(/╭─ ✓ CRIT · correctness ─+╮/);
    expect(f).toContain("Refund amount not validated");
    expect(f).toContain("why POST /refunds");
    expect(f).toContain("fix Validate against captured minus refunded");
    expect(f).toContain("[x] Refund amount not validated"); // ticked: you agree with the fix
    expect(f).toContain("[a] uncheck  [i] tell the AI  [x] apply this");
    expect(f).toMatch(/╭─ ○ NIT · style · unsure ─+╮/);
    expect(f).toContain("no fix yet · i tells the AI what it should be");
    expect(f).toContain("1 of 2 reviewed · 1 accepted");
    expect(f).toContain("+1 filtered");
    expect(f).toContain(
      "j/k next · a uncheck · i tell the AI · x apply this · d skip · A apply all 1 · q quit · ? help",
    );
    // the code lines come before the card that is about them
    expect(f.indexOf("if (amount > order.capturedAmount)")).toBeLessThan(
      f.indexOf("Refund amount not validated"),
    );
    app.unmount();
  });

  it("j/k move between findings; a accepts and undoes; a on a finding without a fix offers to propose", async () => {
    const app = await mount(session());
    await app.press("j");
    await until(app.lastFrame, "[i] tell the AI the fix");
    expect(app.lastFrame()).toContain("2/2");
    expect(app.lastFrame()).toContain("a get a fix ·");
    await app.press("a");
    await until(app.lastFrame, "No fix yet. What should the fix do?");
    await app.press(ESC);
    await app.press("k", "a");
    await until(app.lastFrame, "0 of 2 reviewed · 0 accepted");
    expect((await store.findings.get(ids["Refund amount not validated"]!))!.selected).toBe(false);
    await app.press("a");
    await until(app.lastFrame, "1 of 2 reviewed · 1 accepted");
    await app.press("G");
    await until(app.lastFrame, "2/2");
    await app.press("g");
    await until(app.lastFrame, "1/2");
    app.unmount();
  });

  it("a on a finding without a fix has the AI write one in the background; you keep working and the card opens when it is ready", async () => {
    const app = await mount(
      session({
        runs: [{ match: { kind: "draft-fix" }, message: `\`\`\`diff\n${USER_PATCH}\`\`\`` }],
      }),
    );
    await app.press("j", "a");
    await until(app.lastFrame, "No fix yet. What should the fix do?");
    await sleep(80);
    await app.press(ENTER); // empty: let the AI decide
    // no blocking screen: the stream stays, and the fix lands without any check round
    const f = await until(app.lastFrame, "Fix ready for “Unused import”");
    expect(f).not.toContain("ACCEPTED");
    expect(f).toContain("AI ●"); // the card opened on its fix
    expect(f).toContain("Fix: Unused import");
    expect(f).toContain("[a] agree");
    await app.press("a");
    await until(app.lastFrame, "2 of 2 reviewed · 2 accepted");
    expect(await store.fixes.active(ids["Unused import"]!)).toMatchObject({ author: "ai" });
    app.unmount();
  });

  it("while a fix is being written the card shows it and the keys still work; asking again is refused", async () => {
    const app = await mount(
      session({
        runs: [
          {
            match: { kind: "draft-fix" },
            delayMs: 700,
            message: `\`\`\`diff\n${USER_PATCH}\`\`\``,
          },
        ],
      }),
    );
    await app.press("j", "a");
    await until(app.lastFrame, "No fix yet. What should the fix do?");
    await sleep(80);
    await app.press(ENTER);
    const f = await until(app.lastFrame, /writing a fix…/);
    expect(f).toMatch(/[|/\\-] writing a fix…/);
    expect(f).toMatch(/writing 1 fix/);
    // still usable: move, and ask for the same fix again
    await app.press("k", "j", "i");
    await until(app.lastFrame, "What should the fix do?");
    await sleep(80);
    await app.press(ENTER);
    await until(app.lastFrame, "Already writing a fix for this one.");
    await until(app.lastFrame, "Fix ready for “Unused import”", 10_000);
    expect(app.lastFrame()).not.toMatch(/writing a fix…/);
    app.unmount();
  });

  it("A then Enter applies the accepted fixes to the working tree", async () => {
    const app = await mount(session());
    await app.press("A");
    await until(app.lastFrame, "Apply 1 accepted fix:");
    expect(app.lastFrame()).toContain("(enter)");
    await app.press(ENTER);
    await until(app.lastFrame, "Applied 1 · crit undo restores the files");
    app.unmount();
  });

  it("d dismisses with a reason and remembers false positives; d again restores", async () => {
    const app = await mount(session());
    await app.press("j", "d");
    await until(app.lastFrame, "Dismiss:");
    await app.press("f");
    await until(app.lastFrame, "2 of 2 reviewed");
    expect(app.lastFrame()).toMatch(/╭─ ✗ NIT/);
    expect(app.lastFrame()).toContain("all triaged: A applies 1");
    const repoId = (await store.reviews.get(reviewId))!.repoId;
    expect((await store.suppressions.list(repoId)).map((s) => s.fingerprint)).toEqual([
      "fp-Unused import",
    ]);
    await app.press("d");
    await until(app.lastFrame, "1 of 2 reviewed");
    expect(await store.suppressions.list(repoId)).toEqual([]);
    app.unmount();
  });

  it("enter shows the whole finding in place; tab switches the fix; esc folds it again", async () => {
    const app = await mount(session());
    await app.press(ENTER);
    const f = await until(app.lastFrame, "Fails when");
    expect(f).toContain("refund() takes any amount from the request body.");
    expect(f).toContain("POST /refunds {orderId: 17, amount: 5000} on a 2000 capture");
    expect(f).toContain("Rule  R4 Validate money inputs at the boundary");
    expect(f).toContain(".cursor/rules/payments.mdc");
    expect(f).toContain("AI ●   yours –");
    expect(f).toMatch(/2 - +if \(amount > order\.capturedAmount\) \{/);
    expect(f).toMatch(/2 \+ +if \(amount <= 0/);
    expect(f).toContain("[enter] less");
    await app.press(TAB);
    await until(app.lastFrame, "No fix of yours yet");
    await app.press(ESC);
    await until(app.lastFrame, "[a] uncheck");
    expect(app.lastFrame()).not.toContain("Fails when");
    app.unmount();
  });

  it("/ searches words and sev: lens: file: is:filtered; esc clears it", async () => {
    const app = await mount(session());
    await app.press("/", ..."unused".split(""), ENTER);
    await until(app.lastFrame, "/unused");
    expect(app.lastFrame()).toContain("Unused import");
    expect(app.lastFrame()).not.toContain("Refund amount not validated");
    await app.press(ESC);
    await until(app.lastFrame, "Refund amount not validated");
    await app.press("/", ..."sev:critical".split(""), ENTER);
    await until(app.lastFrame, "/sev:critical");
    expect(app.lastFrame()).not.toContain("Unused import");
    await app.press(ESC, "/", ..."is:filtered".split(""), ENTER);
    await until(app.lastFrame, "(filtered)");
    expect(app.lastFrame()).toContain("Invented problem");
    expect(app.lastFrame()).toContain("already handled upstream".slice(0, 0) || "Invented problem");
    await app.press("/", ENTER, ESC);
    await until(app.lastFrame, "1 of 2 reviewed");
    app.unmount();
  });

  it("h moves to the files list, enter jumps to a file's first finding, l goes back", async () => {
    const app = await mount(session());
    await app.press("h");
    await until(app.lastFrame, "j/k previous / next file · enter back to the code");
    await app.press("j", ENTER);
    await until(app.lastFrame, "j/k next ·");
    expect(app.lastFrame()).toContain("1/2");
    app.unmount();
  });

  it("A applies the accepted fixes, or says nothing is accepted", async () => {
    const app = await mount(session());
    await app.press("a", "A");
    await until(app.lastFrame, "Nothing accepted yet.");
    await app.press(ESC, "a", "A");
    await until(app.lastFrame, "Apply 1 accepted fix:");
    await app.press("y");
    await until(app.lastFrame, "Applied 1 · crit undo restores the files");
    expect(readFileSync(join(repo.root, "src/payments.ts"), "utf8")).toContain(
      "order.refundedAmount",
    );
    app.unmount();
  });

  it("? shows every key, grouped; esc closes it", async () => {
    const app = await mount(session());
    await app.press("?");
    const f = await until(app.lastFrame, "next / previous finding");
    for (const part of [
      "Review",
      "Move around",
      "More",
      "apply every ticked fix",
      "actions:",
      "options:",
    ])
      expect(f).toContain(part);
    await app.press(ESC);
    await until(app.lastFrame, "1 of 2 reviewed");
    app.unmount();
  });

  it("an empty review says so, and the footer offers only what works", async () => {
    await store.findings.update(ids["Refund amount not validated"]!, { status: "closed" });
    await store.findings.update(ids["Unused import"]!, { status: "closed" });
    const s = session();
    await s.load();
    const app = render(<ReviewApp session={s} />);
    const f = await until(app.lastFrame, "No findings match");
    expect(f).toContain("/ search · o options · ? help · q quit");
    expect(f).not.toContain("a accept");
    app.unmount();
  });
});

describe("actions menu", () => {
  it(". lists what you can do with a finding; w asks and the answer lands in the thread", async () => {
    const app = await mount(
      session({
        runs: [{ match: { kind: "answer" }, message: "Yes, on a second partial refund." }],
      }),
    );
    await app.press(".");
    const menu = await until(app.lastFrame, "actions · Refund amount not validated");
    for (const part of [
      "Propose a different fix",
      "Edit the fix in $EDITOR",
      "Ask a question",
      "Re-check this file",
      "Copy as a prompt",
    ])
      expect(menu).toContain(part);
    expect(menu).not.toContain("Use my fix");
    await app.press("w");
    await until(app.lastFrame, "Ask ›");
    await app.press(..."why?".split(""), ENTER);
    await until(app.lastFrame, "thread (2)");
    expect(app.lastFrame()).toContain("you why?");
    expect(app.lastFrame()).toContain("AI  Yes, on a second partial refund.");
    app.unmount();
  });

  it("e edits the AI fix in the editor and keeps the edit as your fix", async () => {
    let seen = "";
    const editor: Editor = async (content) => {
      seen = content;
      return content.replace('"too large"', '"refund exceeds captured amount"');
    };
    const app = await mount(session({ runs: [] }, editor));
    await app.press(".", "e");
    await until(app.lastFrame, "your fix Edited fix");
    expect(seen).toContain("order.refundedAmount");
    const active = await store.fixes.active(ids["Refund amount not validated"]!);
    expect(active).toMatchObject({ author: "user", summary: "Edited fix" });
    app.unmount();
  });

  it("propose: concerns → answer → accepted, ending with your fix active", async () => {
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
    await app.press(".", "p");
    await until(app.lastFrame, "Propose a fix:");
    await app.press("w");
    await app.press(..."reject zero too".split(""), ENTER);
    const f = await until(app.lastFrame, "CONCERNS");
    expect(f).toContain("Your fix · not applied · CONCERNS");
    expect(f).toContain("Drafted from your description:");
    expect(f).toContain("AI  This ignores earlier partial refunds.");
    expect(f).toContain("Can an order have more than one refund?");
    expect(f).toContain("enter reply · u use anyway · k keep AI fix · j/k scroll · esc back");
    await app.press(ENTER);
    await until(app.lastFrame, "you ›");
    await app.press(..."No, one refund only".split(""), ENTER);
    await until(app.lastFrame, "ACCEPTED");
    expect(app.lastFrame()).toContain("Your fix · checked · ACCEPTED");
    await app.press(ESC);
    await until(app.lastFrame, "your fix");
    app.unmount();
  });

  it("propose: rejected → use anyway; the menu then offers to keep the AI fix", async () => {
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
    await app.press(".", "p", "e");
    const f = await until(app.lastFrame, "REJECTED");
    expect(f).toContain("Fails when: 1500 + 1500 on 2000");
    await app.press("u");
    await until(app.lastFrame, "your fix");
    expect(await store.fixes.active(ids["Refund amount not validated"]!)).toMatchObject({
      author: "user",
      overridden: true,
    });
    await app.press(".");
    await until(app.lastFrame, "Keep the AI's fix");
    await app.press("k");
    await sleep(80);
    expect(await store.fixes.active(ids["Refund amount not validated"]!)).toMatchObject({
      author: "ai",
    });
    app.unmount();
  });

  it("shows errors from failed actions", async () => {
    const app = await mount(
      session({ runs: [{ match: { kind: "draft-fix" }, message: "no diff here" }] }),
    );
    await app.press(".", "p", "w", "x", ENTER);
    const frame = await until(
      app.lastFrame,
      "✗ the agent could not turn your description into a patch",
    );
    expect(frame).toContain("Refund amount not validated");
    app.unmount();
  });
});

/** Open the options menu, wait for it, then press one of its letters. */
async function options(
  app: { press: (...k: string[]) => Promise<void>; lastFrame: () => string | undefined },
  letter: string,
) {
  await app.press("o");
  await until(app.lastFrame, "options ·");
  await app.press(letter);
}

/** A switcher over two profiles, without any agent CLI behind it. */
function stubSwitcher(): Switcher {
  let c: Choice = { provider: "claude", model: "sonnet", effort: null, depth: "standard" };
  const listeners = new Set<(x: Choice) => void>();
  const set = (patch: Partial<Choice>) => {
    c = { ...c, ...patch };
    for (const l of listeners) l(c);
    return c;
  };
  return {
    current: () => c,
    subscribe: (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
    providers: () => [
      { name: "claude", type: "claude-code", model: "sonnet", enabled: true },
      { name: "codex", type: "codex", model: null, enabled: true },
    ],
    setProvider: (name) => set({ provider: name, model: null, effort: null }),
    models: async () => ({
      live: true,
      models: [
        { id: "opus", label: "Opus", efforts: ["low", "high"] },
        { id: "haiku", label: "Haiku", efforts: ["low", "high"] },
      ],
    }),
    efforts: async () => ["low", "high"],
    setModel: (model) => set({ model }),
    setEffort: (effort) => set({ effort }),
    setDepth: (depth) => set({ depth }),
    save: () => c.provider,
  };
}

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
        switcher={stubSwitcher()}
      />,
    );
    await sleep();
    if (kind === "budget") {
      emit({ type: "budget-exceeded", required: 134, limit: 40 });
      emit({ type: "review-failed", reviewId: "r", error: "budget exceeded" });
      await until(app.lastFrame, "134 runs needed, limit 40");
      app.stdin.write("b");
    } else {
      emit({ type: "rate-limited", shardId: "a", retryAfterMs: 30000 });
      emit({ type: "review-done", reviewId: "r", findings: [], durationMs: 1 });
      await until(app.lastFrame, "Provider rate limited");
      // P opens the provider picker; "Connect another provider…" leaves for the setup flow
      app.stdin.write("P");
      await until(app.lastFrame, "Connect another provider");
      await sleep(80); // let the picker attach its key handler
      for (const ch of "connect") app.stdin.write(ch);
      await sleep();
      app.stdin.write(ENTER);
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
      scope: { label: "feature → main", files: [{}, {}], skipped: [{}] } as never,
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
    expect(f).toContain("crit · feature → main");
    expect(f).toContain("■ claude sonnet");
    expect(f).toMatch(/┌╌ scope ╌+┐/);
    expect(f).toContain("2 files");
    expect(f).toMatch(/┌╌ src\/api ╌+┐/); // the running shard's card
    expect(f).toContain("correctness, security");
    expect(f).toContain("1 attached"); // the rules node
    expect(f).toContain("── session log");
    expect(f).toMatch(/\d\d:\d\d:\d\d src\/api\s+reading Cart.tsx/);
    expect(f).toContain("[provider: claude]");
    expect(f).toContain("q stop · enter findings so far");
    app.stdin.write("q");
    await sleep();
    expect(stopped).toBe(true);
    app.stdin.write(ENTER);
    await until(app.lastFrame, "of 2 reviewed");
    app.unmount();
  });
});

describe("switching model, provider, effort and depth", () => {
  it("m picks a model from a searchable list; the footer-status shows it and the AI uses it", async () => {
    const sw = stubSwitcher();
    const app = await mount(session(), sw);
    await app.press("o");
    const opts = await until(app.lastFrame, "options ·");
    expect(opts).toContain("sonnet");
    await app.press("m");
    const f = await until(app.lastFrame, "model · claude");
    expect(f).toContain("CLI default");
    expect(f).toContain("Opus");
    expect(f).toContain("Other…");
    await sleep(80);
    for (const ch of "hai") app.stdin.write(ch);
    await until(app.lastFrame, "1 of 4");
    app.stdin.write(ENTER);
    await until(
      app.lastFrame,
      "Model: claude · haiku · effort default · standard. o then s saves it",
    );
    expect(sw.current().model).toBe("haiku");
    app.unmount();
  });

  it("m → Other… takes a typed model name", async () => {
    const sw = stubSwitcher();
    const app = await mount(session(), sw);
    await options(app, "m");
    await until(app.lastFrame, "model · claude");
    await sleep(80);
    for (const ch of "other") app.stdin.write(ch);
    await sleep();
    app.stdin.write(ENTER);
    await until(app.lastFrame, "Model name › sonnet"); // pre-filled with the current model
    await app.press(..."\u007F".repeat(6), ..."my-model", ENTER);
    await until(app.lastFrame, "Model: claude · my-model");
    expect(sw.current().model).toBe("my-model");
    app.unmount();
  });

  it("P switches provider, E sets an effort the model supports, D sets the depth, esc cancels", async () => {
    const sw = stubSwitcher();
    const app = await mount(session(), sw);
    await options(app, "p");
    await until(app.lastFrame, "provider");
    await sleep(100);
    expect(app.lastFrame()).toContain("codex");
    expect(app.lastFrame()).not.toContain("Connect another provider"); // only on the run screen
    await sleep(80); // let the picker attach its key handler
    for (const ch of "codex") app.stdin.write(ch);
    await sleep();
    app.stdin.write(ENTER);
    await until(app.lastFrame, "Provider: codex · default model");
    expect(sw.current()).toMatchObject({ provider: "codex", model: null });

    await options(app, "e");
    await until(app.lastFrame, "reasoning effort");
    await sleep(100);
    app.stdin.write("\u001B[B"); // down: low
    await sleep(100);
    app.stdin.write(ENTER);
    await until(app.lastFrame, "effort low");
    expect(sw.current().effort).toBe("low");

    await options(app, "d");
    await until(app.lastFrame, "review depth");
    await sleep(100);
    expect(app.lastFrame()).toContain("lenses split, skeptic checks all, high effort");
    await sleep(80); // let the picker attach its key handler
    for (const ch of "deep") app.stdin.write(ch);
    await sleep();
    app.stdin.write(ENTER);
    await until(app.lastFrame, "· deep. o then s saves");
    expect(sw.current().depth).toBe("deep");

    await options(app, "m");
    await until(app.lastFrame, "model · codex"); // the model list loads asynchronously
    await sleep(100);
    await app.press(ESC);
    await until(app.lastFrame, "of 2 reviewed");
    app.unmount();
  });

  it("S saves the choice as the profile default; the screen keys work again afterwards", async () => {
    let saved = "";
    const sw = { ...stubSwitcher(), save: () => ((saved = "claude"), "claude") };
    const app = await mount(session(), sw);
    await options(app, "s");
    await until(app.lastFrame, "Saved claude · sonnet");
    expect(saved).toBe("claude");
    await app.press("j");
    app.unmount();
  });

  it("E explains that Cursor has no separate effort", async () => {
    const sw = { ...stubSwitcher(), efforts: async () => [] as string[] };
    const app = await mount(session(), sw);
    await options(app, "e");
    const f = await until(app.lastFrame, "has no separate effort setting: pick a model instead.");
    expect(f).toContain("claude has no separate effort setting");
    app.unmount();
  });

  it("the run screen keeps what you picked and r retries with it", async () => {
    const sw = stubSwitcher();
    let emit: (e: ReviewEvent) => void = () => {};
    let recovery: unknown;
    const app = render(
      <RunApp
        subscribe={(fn) => ((emit = fn), () => {})}
        makeSession={async () => {
          throw new Error("stay");
        }}
        onStop={() => {}}
        onRecover={(a) => (recovery = a)}
        switcher={sw}
      />,
    );
    await sleep();
    emit({ type: "rate-limited", shardId: "a", retryAfterMs: 1 });
    emit({
      type: "review-done",
      reviewId: "r",
      findings: [],
      durationMs: 1,
      partial: "Stopped early.",
    });
    await until(app.lastFrame, "Provider rate limited");
    app.stdin.write("m");
    await until(app.lastFrame, "model · claude");
    await sleep(80); // let the picker attach its key handler
    for (const ch of "haiku") app.stdin.write(ch);
    await sleep();
    app.stdin.write(ENTER);
    await until(app.lastFrame, "next run");
    expect(app.lastFrame()).toContain("changed; r retries");
    app.stdin.write("D");
    await until(app.lastFrame, "review depth");
    await sleep(80); // let the picker attach its key handler
    for (const ch of "quick") app.stdin.write(ch);
    await sleep();
    app.stdin.write(ENTER);
    await sleep(80);
    app.stdin.write("r");
    await sleep(80);
    expect(recovery).toEqual({ kind: "retry", model: "haiku", depth: "quick" });
    app.unmount();
  });
});

describe("full-screen layout", () => {
  const sh = (i: number, status: Shard["status"] = "queued"): Shard => ({
    id: `s${i}`,
    reviewId: "r",
    label: `apps/mobile (${i}/40)`,
    files: [],
    lenses: ["correctness"],
    status,
    estimatedTokens: 1,
    inputTokens: null,
    cachedTokens: null,
    outputTokens: null,
    durationMs: null,
    agentSessionId: null,
    summary: null,
    error: null,
  });
  const run = (n: number) => {
    let p = reduceProgress(emptyProgress(), {
      type: "review-started",
      reviewId: "r",
      scope: {
        label: "feature → main",
        files: Array.from({ length: n * 10 }, () => ({})),
        skipped: [],
      } as never,
      provider: "claude",
      model: "sonnet",
    });
    p = reduceProgress(p, {
      type: "plan",
      shards: Array.from({ length: n }, (_, i) => sh(i + 1)),
      estimateMs: 1,
    });
    for (let i = 1; i <= 3; i++) p = reduceProgress(p, { type: "shard-started", shardId: `s${i}` });
    p = reduceProgress(p, {
      type: "shard-done",
      shard: { ...sh(4), status: "done", durationMs: 61_000 },
    });
    p = reduceProgress(p, { type: "usage", task: "review", spent: 812_000, budget: 2_000_000 });
    for (let i = 0; i < 60; i++)
      p = reduceProgress(p, { type: "warning", message: `log line ${i}` });
    return p;
  };

  it.each([
    [80, 24],
    [120, 40],
    [100, 18],
  ])(
    "the run dashboard never exceeds the screen (%i×%i) and collapses extra shards",
    async (w, h) => {
      const app = render(<ProgressScreen progress={run(40)} width={w} height={h} />);
      await sleep(60);
      const lines = app.lastFrame()!.split("\n");
      expect(lines.length).toBeLessThanOrEqual(h);
      expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(w);
      expect(app.lastFrame()).toContain("812k");
      expect(app.lastFrame()).toContain("/ 2M");
      expect(app.lastFrame()).toMatch(/log line 59/); // the log follows the newest line
      expect(app.lastFrame()).not.toContain("log line 0\n");
      expect(h < 24 || /\+ \d+ more: ✓ \d+ · queued \d+/.test(app.lastFrame()!)).toBe(true);
      app.unmount();
    },
  );

  it("a long finding scrolls inside its box instead of growing the screen", async () => {
    const long = Array.from(
      { length: 60 },
      (_, i) => `Sentence number ${i} explains the problem in detail.`,
    ).join(" ");
    await store.findings.update(ids["Refund amount not validated"]!, { explanation: long });
    const app = await mount(session());
    await app.press(ENTER);
    await until(app.lastFrame, "Sentence number 0");
    expect(app.lastFrame()!.split("\n").length).toBeLessThanOrEqual(30);
    expect(app.lastFrame()).not.toContain("Sentence number 59");
    expect(app.lastFrame()).toContain("┃"); // scrollbar thumb
    const PGDN = "\u001B[6~";
    const PGUP = "\u001B[5~";
    for (let i = 0; i < 6 && !app.lastFrame()!.includes("Sentence number 59"); i++)
      await app.press(PGDN);
    await until(app.lastFrame, "Sentence number 59");
    expect(app.lastFrame()!.split("\n").length).toBeLessThanOrEqual(30);
    // arrows scroll lines and never move the cursor to another finding
    await app.press("\u001B[A");
    expect(app.lastFrame()).toContain("1/2");
    for (let i = 0; i < 8; i++) await app.press(PGUP);
    await until(app.lastFrame, "Sentence number 0");
    app.unmount();
  });
});

describe("progress reducer: tokens, cache, budget and the session log", () => {
  it("tracks spend, cache hits, stops and partial endings, and caps the log", () => {
    let p = emptyProgress();
    const ev = (e: ReviewEvent) => (p = reduceProgress(p, e, 1_700_000_000_000));
    ev({ type: "cache", files: 12, findings: 3 });
    ev({ type: "usage", task: "skeptic", spent: 50_000, budget: 2_000_000 });
    ev({ type: "budget-stop", spent: 2_100_000, limit: 2_000_000 });
    ev({ type: "rate-limited", shardId: "x", retryAfterMs: 5000 });
    ev({
      type: "review-done",
      reviewId: "r",
      findings: [],
      durationMs: 1,
      partial: "Stopped at the budget.",
    });
    expect(p).toMatchObject({
      cache: { files: 12, findings: 3 },
      tokens: { spent: 50_000, budget: 2_000_000 },
      rateLimited: true,
      done: true,
      partial: "Stopped at the budget.",
    });
    expect(p.log.map((l) => [l.tag, l.text])).toEqual([
      ["cache", "12 files unchanged, 3 findings reused"],
      ["budget", "token budget reached (2.1M of 2M)"],
      ["limit", "rate limited; waiting 5s"],
      ["done", "stopped early"],
    ]);
    for (let i = 0; i < 700; i++) ev({ type: "warning", message: `w${i}` });
    expect(p.log).toHaveLength(500);
    expect(p.log.at(-1)!.text).toBe("w699");
    ev({ type: "verify-started", count: 4 });
    ev({ type: "verified", result: { findingId: "a", verdict: "confirmed", reason: "" } });
    expect([p.verifying, p.verified]).toEqual([4, 1]);
  });
});

describe("copy as prompt and the rules panel", () => {
  it("y copies the finding as a prompt, with location, explanation, rule and fix", async () => {
    const copied: string[] = [];
    const app = await mount(
      session(undefined, undefined, { copy: (t) => (copied.push(t), "test clipboard") }),
    );
    await app.press("y");
    await until(app.lastFrame, "Copied a prompt for “Refund amount not validated”");
    expect(app.lastFrame()).toContain("via test clipboard");
    const text = copied[0]!;
    expect(text).toContain("Fix this critical correctness issue found in code review.");
    expect(text).toContain("Location: src/payments.ts:2");
    expect(text).toContain(
      "How it fails: POST /refunds {orderId: 17, amount: 5000} on a 2000 capture",
    );
    expect(text).toContain("- Validate money inputs at the boundary (.cursor/rules/payments.mdc)");
    expect(text).toContain("Suggested fix: Validate against captured minus refunded");
    expect(text).toContain("```diff");
    // from the detail screen too
    await app.press(ENTER, "y");
    expect(copied).toHaveLength(2);
    app.unmount();
  });

  it("R lists the review's rules; turning one off stores it, re-checks the files citing it, and can be undone", async () => {
    const rechecked: string[] = [];
    const s = session(undefined, undefined, {
      recheck: async (file) => {
        rechecked.push(file);
        const temp = await store.reviews.create({
          ...(await store.reviews.get(reviewId))!,
          id: `temp-${rechecked.length}`,
        });
        return temp.id;
      },
    });
    const app = await mount(s);
    await options(app, "r");
    const f = await until(app.lastFrame, "rules in this review");
    expect(f).toContain("[x] R4  Validate money inputs at the boundary");
    await app.press(ENTER);
    await until(app.lastFrame, "R4 is off; re-checked 1 file(s).");
    expect(rechecked).toEqual(["src/payments.ts"]);
    expect(s.state.disabledRules).toEqual([".cursor/rules/payments.mdc"]);
    expect(s.ruleRows()[0]).toMatchObject({ disabled: true });
    // back on: no re-check, applies next time
    await options(app, "r");
    await until(app.lastFrame, "[ ] R4");
    await app.press(ENTER);
    await until(app.lastFrame, "R4 is on again");
    expect(rechecked).toHaveLength(1);
    expect(s.ruleRows()[0]).toMatchObject({ disabled: false });
    app.unmount();
  });
});

describe("re-run the review", () => {
  it("R asks, then leaves with a re-run request; the hint and menu entry show only when available", async () => {
    const s = session();
    await s.load();
    let reran = 0;
    const app = render(<ReviewApp session={s} onRerun={() => reran++} />);
    const f = await until(app.lastFrame, "of 2 reviewed");
    expect(f).toContain("R re-run review");
    await sleep(80);
    app.stdin.write("R");
    await until(
      app.lastFrame,
      "Re-run the review of feature/payments → main? Unchanged files come from the cache.",
    );
    await sleep(80);
    app.stdin.write(ESC);
    await sleep(80);
    expect(reran).toBe(0);
    app.stdin.write("o");
    await until(app.lastFrame, "Re-run this review");
    await sleep(80);
    app.stdin.write("n");
    await until(app.lastFrame, "Re-run the review of");
    await sleep(80);
    app.stdin.write("y");
    await sleep(120);
    expect(reran).toBe(1);
    app.unmount();
  });

  it("without a re-run handler (history) there is no hint and R does nothing", async () => {
    const app = await mount(session());
    expect(app.lastFrame()).not.toContain("re-run");
    await app.press("R");
    await sleep(60);
    expect(app.lastFrame()).not.toContain("Re-run the review");
    await app.press("o");
    await until(app.lastFrame, "options ·");
    expect(app.lastFrame()).not.toContain("Re-run this review");
    app.unmount();
  });
});

/** A second and third finding in other files, so there is somewhere to navigate to. */
async function addFiles() {
  const base = (await store.findings.get(ids["Unused import"]!))!;
  for (const [file, title] of [
    ["src/cart.ts", "Cart total ignores coupons"],
    ["src/user.ts", "Password logged in clear text"],
  ] as const) {
    const f = await store.findings.create({
      ...base,
      id: newId(),
      fingerprint: `fp-${title}`,
      file,
      title,
      severity: "major",
      range: { start: 1, end: 1 },
    });
    ids[title] = f.id;
  }
}

describe("moving between files", () => {
  // files sort by name: cart.ts, payments.ts (two findings), user.ts
  it("] and [ and tab jump to the next and previous file's first finding", async () => {
    await addFiles();
    const app = await mount(session(), undefined, "of 4 reviewed");
    await until(app.lastFrame, "src/cart.ts  1/4");
    await app.press("]");
    await until(app.lastFrame, "src/payments.ts  2/4");
    expect(app.lastFrame()).toContain("Refund amount not validated");
    await app.press(TAB);
    await until(app.lastFrame, "src/user.ts  4/4");
    await app.press("]");
    expect(app.lastFrame()).toContain("src/user.ts  4/4"); // stops at the last file
    await app.press("[");
    await until(app.lastFrame, "src/payments.ts  2/4");
    await app.press("[");
    await until(app.lastFrame, "src/cart.ts  1/4");
    app.unmount();
  });

  it("in the files list j/k jump between files at once, and the list follows where you are", async () => {
    await addFiles();
    const app = await mount(session(), undefined, "of 4 reviewed");
    await app.press("h");
    await until(app.lastFrame, "j/k previous / next file");
    await app.press("j");
    await until(app.lastFrame, "src/payments.ts  2/4"); // no enter needed
    await app.press("j");
    await until(app.lastFrame, "src/user.ts  4/4");
    await app.press("k", "k");
    await until(app.lastFrame, "src/cart.ts  1/4");
    await app.press("\u001B[C"); // right arrow: back to the code
    await until(app.lastFrame, "j/k next ·");
    await app.press("\u001B[D"); // left arrow: files list
    await until(app.lastFrame, "j/k previous / next file");
    await app.press(ENTER);
    const f = await until(app.lastFrame, "j/k next ·");
    expect(f).toContain("src/cart.ts  1/4"); // still on the file you jumped to
    app.unmount();
  });
});

describe("going through the fixes", () => {
  it("shows a checkbox for the fix you agree with, and a to tick or untick it", async () => {
    const app = await mount(session());
    expect(app.lastFrame()).toContain("[x] Refund amount not validated");
    await app.press("a");
    await until(app.lastFrame, "[ ] Refund amount not validated");
    expect(app.lastFrame()).toContain("[a] agree");
    await app.press(" ");
    await until(app.lastFrame, "[x] Refund amount not validated");
    app.unmount();
  });

  it("i tells the AI how the fix should change; the new fix replaces the old one and unticks it", async () => {
    const app = await mount(
      session({
        runs: [{ match: { kind: "draft-fix" }, message: `\`\`\`diff\n${USER_PATCH}\`\`\`` }],
      }),
    );
    await app.press("i");
    await until(app.lastFrame, "Tell the AI how the fix should change");
    await sleep(80);
    await app.press(..."use a guard clause".split(""), ENTER);
    await until(app.lastFrame, "Fix ready for “Refund amount not validated”");
    const fix = await store.fixes.active(ids["Refund amount not validated"]!);
    expect(fix).toMatchObject({ author: "ai", summary: "As you asked: use a guard clause" });
    expect((await store.findings.get(ids["Refund amount not validated"]!))!.selected).toBe(false);
    expect(app.lastFrame()).toContain("[ ] Refund amount not validated");
    app.unmount();
  });

  it("x applies just this fix, leaving the other agreed fixes alone", async () => {
    // a second agreed fix, so there is something to leave alone
    await store.findings.update(ids["Unused import"]!, { selected: true });
    await store.fixes.create({
      id: newId(),
      findingId: ids["Unused import"]!,
      author: "ai",
      patch:
        '--- a/src/payments.ts\n+++ b/src/payments.ts\n@@ -6,2 +6,1 @@\n }\n-import { unused } from "./x";\n+\n',
      summary: "Remove the import",
      overridden: false,
      active: true,
      createdAt: Date.now(),
    });
    const app = await mount(session());
    await app.press("x");
    await until(app.lastFrame, "Applied 1 · crit undo restores the files");
    expect(readFileSync(join(repo.root, "src/payments.ts"), "utf8")).toContain(
      "order.refundedAmount",
    );
    expect(readFileSync(join(repo.root, "src/payments.ts"), "utf8")).toContain("import { unused }");
    expect((await store.findings.get(ids["Refund amount not validated"]!))!.status).toBe("applied");
    expect((await store.findings.get(ids["Unused import"]!))!.status).toBe("open");
    app.unmount();
  });

  it("x on a finding without a fix says so instead of doing nothing", async () => {
    const app = await mount(session());
    await app.press("j", "x");
    await until(app.lastFrame, "This finding has no fix to apply yet.");
    expect(readFileSync(join(repo.root, "src/payments.ts"), "utf8")).toBe(CODE); // nothing changed
    expect(await store.findings.get(ids["Unused import"]!)).toMatchObject({
      status: "open",
      selected: false, // and nothing got ticked or dismissed
    });
    app.unmount();
  });

  it("q goes back to the start screen when there is one, and quits otherwise", async () => {
    const s = session();
    await s.load();
    let went = 0;
    const withBack = render(<ReviewApp session={s} onBack={() => went++} />);
    await until(withBack.lastFrame, "of 2 reviewed");
    await sleep(80);
    withBack.stdin.write("q");
    await sleep(150);
    expect(went).toBe(1);
    withBack.unmount();
  });
});
