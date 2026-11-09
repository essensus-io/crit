import type { ScopeSpec } from "@crit/schema";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import {
  type Estimate,
  HomeApp,
  type HomeChoice,
  type RecentReview,
} from "../src/tui/home-screen.tsx";

const sleep = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function until(frame: () => string | undefined, text: string | RegExp, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const f = frame() ?? "";
    if (typeof text === "string" ? f.includes(text) : text.test(f)) return f;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${String(text)} in:\n${frame()}`);
}
const ENTER = "\r";
const TAB = "\t";
const ESC = "\u001B";

const RECENT: RecentReview[] = [
  {
    id: "01-aaaa",
    label: "feature → develop",
    when: "today 14:02",
    findings: "3 findings",
    outcome: "open",
  },
  {
    id: "01-bbbb",
    label: "src/api",
    when: "yesterday",
    findings: "1 findings",
    outcome: "2 applied",
  },
];

function mount(
  over: {
    estimate?: (s: ScopeSpec) => Promise<Estimate>;
    recent?: RecentReview[];
    initialSpec?: ScopeSpec;
    bases?: { ref: string; ahead: number }[];
  } = {},
) {
  const done: HomeChoice[] = [];
  const estimate = vi.fn<(s: ScopeSpec) => Promise<Estimate>>(
    over.estimate ??
      (async () => ({ ok: true, files: 27, skipped: 4, runs: 3, tokens: 30_000, cached: 2 })),
  );
  const app = render(
    <HomeApp
      info={{ repo: "fieldhive", branch: "fix/portal", base: "origin/develop" }}
      bases={over.bases ?? []}
      recent={over.recent ?? RECENT}
      initialSpec={over.initialSpec}
      estimate={estimate}
      onDone={(c) => done.push(c)}
    />,
  );
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      app.stdin.write(k);
      await sleep(k === ESC ? 70 : 40);
    }
  };
  return { app, done, estimate, press };
}

describe("start screen", () => {
  it("shows what you can review, what it would cost, and your recent reviews; nothing starts by itself", async () => {
    const { app, done, estimate } = mount();
    const f = await until(app.lastFrame, "27 files");
    expect(f).toContain("crit · fieldhive · on fix/portal");
    expect(f).toContain("This branch vs origin/develop");
    for (const option of ["Staged changes", "Last commit", "Whole project", "Specific paths…"])
      expect(f).toContain(option);
    expect(f).toContain("27 files · 3 runs");
    expect(f).toContain("~30k tokens · 2 cached · 4 skipped");
    expect(f).toContain("▶ Start review");
    expect(f).toContain("recent reviews");
    expect(f).toContain("feature → develop");
    expect(f).toContain("today 14:02 · 3 findings · open");
    expect(f).toContain("j/k choose · enter start · tab recent reviews · o model & depth · q quit");
    await sleep(200);
    expect(done).toEqual([]); // only an estimate was made: no review without enter
    expect(estimate).toHaveBeenCalledTimes(1);
    expect(estimate).toHaveBeenCalledWith({ kind: "branch", base: "origin/develop" });
    app.unmount();
  });

  it("j/k choose a scope (the estimate follows) and enter starts it", async () => {
    const { app, done, estimate, press } = mount();
    await until(app.lastFrame, "27 files");
    await press("j");
    await until(app.lastFrame, "what `git add` has prepared");
    expect(estimate).toHaveBeenLastCalledWith({ kind: "staged" });
    await press("j", "j");
    await until(app.lastFrame, "every tracked file: the most tokens");
    await press("k");
    await press(ENTER);
    await sleep(80);
    expect(done).toEqual([
      { kind: "start", spec: { kind: "commit", sha: "HEAD" }, choice: undefined },
    ]);
    app.unmount();
  });

  it("specific paths: enter asks for them, then estimates and starts with them", async () => {
    const { app, done, estimate, press } = mount();
    await until(app.lastFrame, "27 files");
    await press("j", "j", "j", "j");
    await until(app.lastFrame, "Press enter to type the paths.");
    await press(ENTER);
    await until(app.lastFrame, "Paths to review");
    await sleep(60);
    await press(..."src lib/*.ts".split(""), ENTER);
    await until(app.lastFrame, "src lib/*.ts");
    await until(app.lastFrame, "27 files");
    expect(estimate).toHaveBeenLastCalledWith({
      kind: "paths",
      paths: ["src", "lib/*.ts"],
      diff: false,
    });
    await press(ENTER);
    await sleep(80);
    expect(done).toEqual([
      {
        kind: "start",
        spec: { kind: "paths", paths: ["src", "lib/*.ts"], diff: false },
        choice: undefined,
      },
    ]);
    app.unmount();
  });

  it("tab moves to the recent reviews; enter opens the one you picked", async () => {
    const { app, done, press } = mount();
    await until(app.lastFrame, "27 files");
    await press(TAB);
    await until(app.lastFrame, "enter open that review");
    await press("j", ENTER);
    await sleep(80);
    expect(done).toEqual([{ kind: "open", reviewId: "01-bbbb" }]);
    app.unmount();
  });

  it("q quits without starting anything", async () => {
    const { app, done, press } = mount();
    await until(app.lastFrame, "27 files");
    await press("q");
    await sleep(80);
    expect(done).toEqual([{ kind: "quit" }]);
    app.unmount();
  });

  it("opens with the scope you asked for on the command line", async () => {
    const { app, estimate } = mount({ initialSpec: { kind: "staged" } });
    await until(app.lastFrame, "27 files");
    expect(estimate).toHaveBeenCalledWith({ kind: "staged" });
    expect(app.lastFrame()).toMatch(/● Staged changes/);
    app.unmount();
  });

  it("shows why a scope cannot be reviewed, and refuses to start an empty one", async () => {
    const { app, done, press } = mount({
      estimate: async (s) =>
        s.kind === "staged"
          ? { ok: false, message: "crit: nothing is staged" }
          : { ok: true, files: 0, skipped: 0, runs: 0, tokens: 0, cached: 0 },
    });
    await until(app.lastFrame, "0 files");
    await press(ENTER);
    await until(app.lastFrame, "Nothing to review in that scope. Pick another.");
    await press("j");
    await until(app.lastFrame, "crit: nothing is staged");
    await sleep(100);
    expect(done).toEqual([]);
    app.unmount();
  });

  it("with no history the recent panel says so and tab does nothing", async () => {
    const { app, press } = mount({ recent: [] });
    await until(app.lastFrame, "None yet in this repository.");
    expect(app.lastFrame()).not.toContain("tab recent reviews");
    await press(TAB);
    expect(app.lastFrame()).toContain("j/k choose · enter start");
    app.unmount();
  });

  it("warns when the estimate is huge, and b picks another base to compare against", async () => {
    const { app, done, estimate, press } = mount({
      bases: [
        { ref: "origin/main", ahead: 353 },
        { ref: "origin/develop", ahead: 2 },
      ],
      estimate: async (s) => ({
        ok: true,
        files: s.kind === "branch" && s.base === "origin/main" ? 1472 : 35,
        skipped: 0,
        runs: 3,
        tokens: s.kind === "branch" && s.base === "origin/main" ? 4_800_000 : 90_000,
        cached: 0,
      }),
    });
    await until(app.lastFrame, "35 files");
    await press("b");
    await until(app.lastFrame, "compare this branch against");
    await sleep(80);
    await press("1");
    await until(app.lastFrame, "Press b to pick another.");
    expect(app.lastFrame()).toContain("1472 files");
    expect(estimate).toHaveBeenLastCalledWith({ kind: "branch", base: "origin/main" });
    await press("b");
    await until(app.lastFrame, "compare this branch against");
    await sleep(80);
    await press("2");
    await until(app.lastFrame, "35 files");
    await press(ENTER);
    expect(done[0]).toMatchObject({
      kind: "start",
      spec: { kind: "branch", base: "origin/develop" },
    });
  });
});
