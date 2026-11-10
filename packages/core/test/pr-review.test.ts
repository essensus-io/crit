import { type Finding, newId } from "@crit/schema";
import { openStore, type SqliteStore } from "@crit/store";
import { createFixtureRepo, type FixtureRepo } from "@crit/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GhError, type GhRunner, publishPrReview } from "../src/index.ts";
import { defuseMentions, findingMarker } from "../src/github/review-comment.ts";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const one = 1;
+const two = 2;
 const three = 3;
`;
const PR_VIEW = JSON.stringify({
  number: 7,
  url: "https://github.com/acme/shop/pull/7",
  headRefOid: "abc123",
  state: "OPEN",
});

type Call = { args: string[]; input?: string };
const fakeGh = (opts: { posted?: string; view?: { stderr: string } } = {}) => {
  const calls: Call[] = [];
  const gh: GhRunner = async (_cwd, args, input) => {
    calls.push({ args, ...(input === undefined ? {} : { input }) });
    const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
    if (args[0] === "pr" && args[1] === "view")
      return opts.view ? { stdout: "", stderr: opts.view.stderr, exitCode: 1 } : ok(PR_VIEW);
    if (args[0] === "pr" && args[1] === "diff") return ok(DIFF);
    if (args.includes("--method")) return ok(JSON.stringify({ html_url: "https://x/review/1" }));
    return ok(opts.posted ?? "");
  };
  return { gh, calls };
};

let repo: FixtureRepo;
let store: SqliteStore;
let reviewId: string;

const add = async (key: string, over: Partial<Finding> = {}) => {
  await store.findings.create({
    id: newId(),
    reviewId,
    fingerprint: `fp-${key}`,
    file: "src/a.ts",
    range: { start: 2, end: 2 },
    anchor: "const two = 2;",
    severity: "major",
    category: "correctness",
    title: key,
    explanation: "why",
    confidence: 0.9,
    ruleIds: [],
    status: "open",
    selected: false,
    mergedFrom: [],
    createdAt: Date.now(),
    ...over,
  });
};

beforeEach(async () => {
  repo = createFixtureRepo({ "src/a.ts": "const one = 1;\nconst two = 2;\nconst three = 3;\n" });
  store = openStore();
  const r = await store.repos.upsert({ root: repo.root, remoteUrl: null, name: "x" });
  reviewId = newId();
  await store.reviews.create({
    id: reviewId,
    repoId: r.id,
    scope: { kind: "project" },
    scopeLabel: "x",
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
    startedAt: 1,
    finishedAt: 2,
  });
});
afterEach(() => {
  store.close();
  repo.cleanup();
});

const run = (gh: GhRunner, findingIds?: string[]) =>
  publishPrReview({ gh, store, root: repo.root, reviewId, findingIds });

describe("publishPrReview", () => {
  it("posts one review with an inline comment per open finding", async () => {
    await add("Bug");
    const { gh, calls } = fakeGh();
    const result = await run(gh);
    const post = JSON.parse(calls.find((call) => call.input)!.input!);
    expect(result.url).toBe("https://x/review/1");
    expect(post.commit_id).toBe("abc123");
    expect(post.comments).toHaveLength(1);
    expect(post.comments[0]).toMatchObject({ path: "src/a.ts", line: 2, side: "RIGHT" });
  });

  it("posts only the findings it is asked for", async () => {
    await add("Wanted");
    await add("Left", { fingerprint: "fp-left" });
    const wanted = (await store.findings.listByReview(reviewId)).find((f) => f.title === "Wanted")!;
    const { gh, calls } = fakeGh();
    await run(gh, [wanted.id]);
    const post = JSON.parse(calls.find((call) => call.input)!.input!);
    expect(post.comments).toHaveLength(1);
    expect(post.comments[0].body).toContain("Wanted");
  });

  it("skips dismissed findings", async () => {
    await add("Gone", { status: "dismissed" });
    const { gh, calls } = fakeGh();
    const result = await run(gh);
    expect(result.url).toBeUndefined();
    expect(calls.some((call) => call.input)).toBe(false);
  });

  it("does not post a finding that is already on the pull request", async () => {
    await add("Bug");
    const { gh, calls } = fakeGh({ posted: findingMarker("fp-Bug") });
    const result = await run(gh);
    expect(result.alreadyPosted).toBe(1);
    expect(calls.some((call) => call.input)).toBe(false);
  });

  it("puts a finding outside the diff in the review body instead of dropping it", async () => {
    await add("Elsewhere", { anchor: "not in the diff" });
    const { gh, calls } = fakeGh();
    const result = await run(gh);
    const post = JSON.parse(calls.find((call) => call.input)!.input!);
    expect(result.outsideDiff).toBe(1);
    expect(post.comments).toEqual([]);
    expect(post.body).toContain("Elsewhere");
  });

  it("explains when the branch has no open pull request", async () => {
    const { gh } = fakeGh({ view: { stderr: 'no pull requests found for branch "main"' } });
    await expect(run(gh)).rejects.toThrow(/no open pull request/);
  });

  it("reports a missing gh binary", async () => {
    const gh: GhRunner = async () => {
      throw new GhError("crit: the GitHub CLI (gh) is not installed.");
    };
    await expect(run(gh)).rejects.toThrow(/not installed/);
  });
});

describe("defuseMentions", () => {
  it("breaks @mentions outside code spans and keeps code spans", () => {
    const out = defuseMentions("ping @alice, but `@types/node` stays");
    expect(out).not.toContain("@alice");
    expect(out).toContain("`@types/node`");
  });
});
