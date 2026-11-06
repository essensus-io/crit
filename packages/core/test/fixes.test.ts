import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeAdapter, FakeScript, type FakeScriptInput } from "@crit/providers";
import { DEFAULT_CONFIG, type Finding, type Fix, newId } from "@crit/schema";
import { openStore, type SqliteStore } from "@crit/store";
import { createFixtureRepo, type FixtureRepo } from "@crit/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  askAboutFinding,
  diffFromEdit,
  dismissFinding,
  type FixContext,
  FixError,
  keepAiFix,
  MAX_PROPOSAL_ROUNDS,
  patchedContent,
  draftAiFix,
  proposeFix,
  restoreFinding,
  saveEditedFix,
  useFixAnyway,
  verifyInWorktree,
} from "../src/index.ts";

const CODE = `export async function refund(order, amount, provider) {
  if (amount > order.capturedAmount) {
    throw new HttpError(422, "too large");
  }
  await provider.refund(order.chargeId, amount);
}
`;
const AI_PATCH = `--- a/src/pay.ts
+++ b/src/pay.ts
@@ -1,4 +1,4 @@
 export async function refund(order, amount, provider) {
-  if (amount > order.capturedAmount) {
+  if (amount <= 0 || amount > order.capturedAmount - order.refundedAmount) {
     throw new HttpError(422, "too large");
   }
`;
const USER_PATCH = `--- a/src/pay.ts
+++ b/src/pay.ts
@@ -1,4 +1,4 @@
 export async function refund(order, amount, provider) {
-  if (amount > order.capturedAmount) {
+  if (amount > order.capturedAmount || amount <= 0) {
     throw new HttpError(422, "too large");
   }
`;

let repo: FixtureRepo;
let store: SqliteStore;
let finding: Finding;
let aiFix: Fix;

beforeEach(async () => {
  repo = createFixtureRepo({ "src/pay.ts": CODE });
  store = openStore();
  const r = await store.repos.upsert({ root: repo.root, remoteUrl: null, name: "x" });
  const reviewId = newId();
  await store.reviews.create({
    id: reviewId,
    repoId: r.id,
    scope: { kind: "project" },
    scopeLabel: "whole project",
    branch: "main",
    baseSha: null,
    headSha: null,
    provider: "fake",
    model: null,
    lenses: ["correctness"],
    status: "completed",
    supersededBy: null,
    summary: null,
    rulesHeader: null,
    startedAt: Date.now(),
    finishedAt: null,
  });
  finding = await store.findings.create({
    id: newId(),
    reviewId,
    fingerprint: "fp1",
    file: "src/pay.ts",
    range: { start: 2, end: 2 },
    anchor: "if (amount > order.capturedAmount) {",
    severity: "critical",
    category: "correctness",
    title: "Refund ignores earlier partial refunds",
    explanation: "Two refunds of 1500 on a 2000 capture both pass.",
    confidence: 0.9,
    ruleIds: [],
    status: "open",
    selected: true,
    mergedFrom: [],
    createdAt: Date.now(),
  });
  aiFix = await store.fixes.create({
    id: newId(),
    findingId: finding.id,
    author: "ai",
    patch: AI_PATCH,
    summary: "Account for refunded amount",
    overridden: false,
    active: true,
    createdAt: Date.now(),
  });
});
afterEach(() => {
  store.close();
  repo.cleanup();
});

function ctxWith(
  script: FakeScriptInput,
  over: Partial<FixContext["config"]> = {},
): FixContext & { fake: FakeAdapter } {
  const fake = new FakeAdapter(FakeScript.parse(script), { model: null });
  return {
    fake,
    store,
    provider: {
      profile: { name: "f", type: "fake", command: "x", model: "m1", enabled: true },
      adapter: fake,
    },
    root: repo.root,
    config: { review: DEFAULT_CONFIG.review, verify: { commands: [] }, ...over },
    read: async (p) => readFileSync(join(repo.root, p), "utf8"),
  };
}
const verdict = (v: object) => ({ match: { kind: "evaluate-fix" }, message: JSON.stringify(v) });

describe("proposeFix: the three verdicts", () => {
  it("accepted: the user fix replaces the AI fix, labeled as yours", async () => {
    const ctx = ctxWith({
      runs: [
        verdict({ verdict: "accepted", reason: "Covers the zero case and the capture limit." }),
      ],
    });
    const out = await proposeFix(ctx, finding, { kind: "patch", patch: USER_PATCH });
    expect(out).toMatchObject({ evaluation: { verdict: "accepted" }, round: 1, finalRound: false });
    expect(await store.fixes.active(finding.id)).toMatchObject({
      id: out.fix.id,
      author: "user",
      evaluation: "accepted",
      summary: "Your fix",
    });
    expect((await store.fixes.get(aiFix.id))!.active).toBe(false);
    const prompt = ctx.fake.calls[0]!.task.prompt;
    expect(prompt).toContain("AI fix (Account for refunded amount)");
    expect(prompt).toContain("User's fix:");
    expect(prompt).toContain(">2    if (amount > order.capturedAmount) {");
    expect(ctx.fake.calls[0]!.task).toMatchObject({ kind: "evaluate-fix", model: "m1" });
  });

  it("concerns: one specific question, the answer starts the next round, max 3 rounds", async () => {
    const ctx = ctxWith({
      runs: [
        verdict({
          verdict: "concerns",
          reason: "This stops one oversized refund but ignores earlier partial refunds.",
          question: "Can an order have more than one refund?",
        }),
        verdict({ verdict: "concerns", reason: "Still ignores refundedAmount." }),
        verdict({ verdict: "concerns", reason: "Hm.", question: "Sure?" }),
      ],
    });
    const r1 = await proposeFix(ctx, finding, { kind: "patch", patch: USER_PATCH });
    expect(r1.evaluation).toMatchObject({
      verdict: "concerns",
      question: "Can an order have more than one refund?",
    });
    expect((await store.fixes.active(finding.id))!.id).toBe(aiFix.id);
    const r2 = await proposeFix(
      ctx,
      finding,
      { kind: "patch", patch: USER_PATCH },
      { answer: "Yes, partial refunds are allowed" },
    );
    expect(r2.round).toBe(2);
    expect(r2.evaluation.question).toBe(
      "Can you say more about the case your fix is meant to handle?",
    );
    expect(ctx.fake.calls[1]!.task.prompt).toContain("User: Yes, partial refunds are allowed");
    const r3 = await proposeFix(ctx, finding, { kind: "patch", patch: USER_PATCH });
    expect(r3).toMatchObject({ round: MAX_PROPOSAL_ROUNDS, finalRound: true });
    await expect(proposeFix(ctx, finding, { kind: "patch", patch: USER_PATCH })).rejects.toThrow(
      /already ran 3 rounds/,
    );
    const thread = await store.messages.listByFinding(finding.id);
    expect(thread.map((m) => m.role)).toEqual(["ai", "user", "ai", "ai"]);
    expect(thread[0]!.body).toBe(
      "[evaluation] concerns: This stops one oversized refund but ignores earlier partial refunds.\nCan an order have more than one refund?",
    );
  });

  it("rejected: the reason with the failing case; use anyway records the override", async () => {
    const ctx = ctxWith({
      runs: [
        verdict({
          verdict: "rejected",
          reason: "Drops the null check.",
          failingCase: "order is null after a race",
        }),
      ],
    });
    const out = await proposeFix(ctx, finding, { kind: "patch", patch: USER_PATCH });
    expect(out.fix.active).toBe(false);
    expect((await store.messages.listByFinding(finding.id))[0]!.body).toBe(
      "[evaluation] rejected: Drops the null check.\nFails when: order is null after a race",
    );
    const used = await useFixAnyway(store, out.fix.id);
    expect(used).toMatchObject({ active: true, overridden: true });
    expect((await store.fixes.active(finding.id))!.id).toBe(out.fix.id);
    expect((await store.messages.listByFinding(finding.id)).at(-1)!.body).toBe(
      "[override] used my fix despite the rejected verdict",
    );
    expect((await keepAiFix(store, finding.id))!.id).toBe(aiFix.id);
    expect((await store.fixes.active(finding.id))!.id).toBe(aiFix.id);
    await expect(useFixAnyway(store, "nope")).rejects.toThrow(FixError);
  });
});

describe("proposeFix: inputs and failures", () => {
  it("drafts a patch from a description first", async () => {
    const ctx = ctxWith({
      runs: [
        { match: { kind: "draft-fix" }, message: `\`\`\`diff\n${USER_PATCH}\`\`\`` },
        verdict({ verdict: "accepted", reason: "ok" }),
      ],
    });
    const out = await proposeFix(ctx, finding, {
      kind: "description",
      text: "Also reject zero and negative amounts\nmore detail",
    });
    expect(out.drafted).toBe(USER_PATCH);
    expect(out.fix.summary).toBe("Also reject zero and negative amounts");
    expect(ctx.fake.calls[0]!.task.prompt).toContain("The user describes the fix they want:");

    const bad = ctxWith({ runs: [{ match: { kind: "draft-fix" }, message: "I'd rather not." }] });
    await expect(proposeFix(bad, finding, { kind: "description", text: "x" })).rejects.toThrow(
      /could not turn your description into a patch/,
    );
  });

  it("rejects patches that do not apply", async () => {
    const ctx = ctxWith({ runs: [] });
    await expect(
      proposeFix(ctx, finding, {
        kind: "patch",
        patch: USER_PATCH.replace("order.capturedAmount) {", "nothing) {"),
      }),
    ).rejects.toThrow(/does not apply/);
  });

  it("repairs a bad evaluator reply once, then gives up", async () => {
    const ok = ctxWith({
      runs: [
        { match: { kind: "evaluate-fix" }, message: "Looks fine to me!" },
        verdict({ verdict: "accepted", reason: "fine" }),
      ],
    });
    expect(
      (await proposeFix(ok, finding, { kind: "patch", patch: USER_PATCH })).evaluation.verdict,
    ).toBe("accepted");
    const bad = ctxWith({
      runs: [{ match: { kind: "evaluate-fix" }, message: "x", repeat: true }],
    });
    await expect(proposeFix(bad, finding, { kind: "patch", patch: USER_PATCH })).rejects.toThrow(
      /no usable verdict/,
    );
  });

  it("verifies in a temporary worktree; a failing verify keeps the AI fix", async () => {
    repo.write({ "README.md": "uncommitted\n" });
    repo.git("add", "README.md");
    const ctx = ctxWith(
      {
        runs: [
          verdict({ verdict: "accepted", reason: "ok" }),
          verdict({ verdict: "accepted", reason: "ok" }),
        ],
      },
      { verify: { commands: ["grep -q 'amount <= 0' src/pay.ts && test -f README.md"] } },
    );
    const pass = await proposeFix(ctx, finding, { kind: "patch", patch: USER_PATCH });
    expect(pass.verify?.passed).toBe(true);
    expect(pass.fix.active).toBe(true);
    expect(readFileSync(join(repo.root, "src/pay.ts"), "utf8")).toBe(CODE);
    expect(repo.git("worktree", "list").split("\n")).toHaveLength(1);

    await keepAiFix(store, finding.id);
    ctx.config.verify.commands = ["exit 1"];
    const fail = await proposeFix(ctx, finding, { kind: "patch", patch: USER_PATCH });
    expect(fail.verify?.passed).toBe(false);
    expect(fail.fix.active).toBe(false);
  });

  it("reports a fix that does not apply in the verify worktree", async () => {
    repo.write({ "src/pay.ts": CODE.replace("too large", "TOO LARGE") });
    await expect(
      verifyInWorktree(repo.root, USER_PATCH.replace('"too large"', '"nope"'), ["true"]),
    ).rejects.toThrow(/does not apply in the verify worktree/);
  });
});

describe("edit, ask, dismiss", () => {
  it("round-trips an edit of the patched file into a user fix", async () => {
    const patched = patchedContent(CODE, AI_PATCH);
    expect(patched).toContain("order.refundedAmount");
    const edited = patched.replace('"too large"', '"refund exceeds captured amount"');
    const patch = diffFromEdit("src/pay.ts", CODE, edited)!;
    expect(patch.startsWith("--- a/src/pay.ts\n+++ b/src/pay.ts\n@@")).toBe(true);
    const fix = await saveEditedFix(store, repo.root, finding, patch);
    expect(fix).toMatchObject({ author: "user", active: true, summary: "Edited fix" });
    expect(diffFromEdit("src/pay.ts", CODE, CODE)).toBeUndefined();
    expect(() => patchedContent("totally different\n", AI_PATCH)).toThrow(/does not apply/);
    await expect(
      saveEditedFix(store, repo.root, finding, AI_PATCH.replace("capturedAmount) {", "zzz) {")),
    ).rejects.toThrow(/your edit does not apply/);
  });

  it("answers a question with the code in view", async () => {
    const ctx = ctxWith({
      runs: [
        { match: { kind: "answer" }, message: " Yes: line 2 only checks the capture. " },
        { match: { kind: "answer" }, exitCode: 1 },
      ],
    });
    const m = await askAboutFinding(ctx, finding, "Can session.user be null here?");
    expect(m).toMatchObject({ role: "ai", body: "Yes: line 2 only checks the capture." });
    expect(ctx.fake.calls[0]!.task.prompt).toContain("User: Can session.user be null here?");
    await expect(askAboutFinding(ctx, finding, "again?")).rejects.toThrow(
      /no answer from the agent/,
    );
    expect((await store.messages.listByFinding(finding.id)).map((x) => x.role)).toEqual([
      "user",
      "ai",
      "user",
    ]);
  });

  it("dismisses with a reason; false positives are suppressed per repo until restored", async () => {
    const repoId = (await store.reviews.get(finding.reviewId))!.repoId;
    const later = await dismissFinding(store, finding, "later");
    expect(later).toMatchObject({ status: "dismissed", dismissReason: "later", selected: false });
    expect(await store.suppressions.list(repoId)).toEqual([]);
    await dismissFinding(store, finding, "false-positive");
    expect((await store.suppressions.list(repoId)).map((s) => s.fingerprint)).toEqual(["fp1"]);
    const restored = await restoreFinding(store, (await store.findings.get(finding.id))!);
    expect(restored.status).toBe("open");
    expect(restored.dismissReason).toBeUndefined();
    expect(await store.suppressions.list(repoId)).toEqual([]);
  });
});

describe("draftAiFix", () => {
  it("is one short, cheap call with a trimmed prompt, and stores the result as the AI's active fix", async () => {
    const ctx = ctxWith({
      runs: [{ match: { kind: "draft-fix" }, message: `\`\`\`diff\n${USER_PATCH}\`\`\`` }],
    });
    ctx.provider.profile.fastModel = "tiny";
    const fix = await draftAiFix(ctx, finding);
    expect(fix).toMatchObject({ author: "ai", active: true, summary: `Fix: ${finding.title}` });
    expect(fix.evaluation).toBeUndefined(); // no second model pass judging it
    expect(await ctx.store.fixes.active(finding.id)).toMatchObject({ id: fix.id });
    expect(ctx.fake.calls).toHaveLength(1);
    const task = ctx.fake.calls[0]!.task;
    expect(task).toMatchObject({ kind: "draft-fix", access: "none", effort: "low", model: "tiny" });
    expect(task.prompt).toContain("lines 1-");
    expect(task.prompt).toContain("Write the smallest change that fixes this finding.");
  });

  it("shows only the lines around the finding, not the whole file", async () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
    const ctx = ctxWith({ runs: [{ match: { kind: "draft-fix" }, message: "no diff" }] });
    ctx.read = async () => big;
    await expect(draftAiFix(ctx, { ...finding, range: { start: 250, end: 251 } })).rejects.toThrow(
      /could not turn this finding into a patch/,
    );
    const prompt = ctx.fake.calls[0]!.task.prompt;
    expect(prompt).toContain("lines 210-291 of 500");
    expect(prompt).toContain("line 250");
    expect(prompt).not.toContain("line 100\n");
    expect(prompt).not.toContain("line 400\n");
  });

  it("rejects a patch that does not apply, and falls back to the main model without a fast one", async () => {
    const bad = "--- a/src/pay.ts\n+++ b/src/pay.ts\n@@ -1,1 +1,1 @@\n-nothing like this\n+x\n";
    const ctx = ctxWith({
      runs: [{ match: { kind: "draft-fix" }, message: `\`\`\`diff\n${bad}\`\`\`` }],
    });
    await expect(draftAiFix(ctx, finding)).rejects.toThrow(/drafted fix does not apply/);
    expect(ctx.fake.calls[0]!.task.model).toBe("m1");
  });
});
