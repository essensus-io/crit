import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFixtureRepo, type FixtureRepo } from "@crit/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAtRevision, resolveScope } from "../src/index.ts";

let repo: FixtureRepo;

beforeEach(() => {
  repo = createFixtureRepo({ "src/a.ts": "export const a = 1;\n" });
  repo.git("checkout", "-q", "-b", "feature/other");
  repo.commit("other work", {
    "src/a.ts": "export const a = 2;\n",
    "src/b.ts": "export const b = 1;\n",
  });
  repo.git("checkout", "-q", "main");
});
afterEach(() => repo.cleanup());

describe("scope of another branch", () => {
  it("reviews a branch that is not checked out, without touching the working tree", async () => {
    const scope = await resolveScope({
      cwd: repo.root,
      spec: { kind: "ref", ref: "feature/other" },
    });
    expect(scope.label).toBe("feature/other → main");
    expect(scope.branch).toBe("feature/other");
    expect(scope.files.map((file) => file.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(readFileSync(join(repo.root, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(repo.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("reads files from the branch, not from the working tree", async () => {
    const scope = await resolveScope({
      cwd: repo.root,
      spec: { kind: "ref", ref: "feature/other" },
    });
    expect(await readAtRevision(scope, "src/a.ts")).toBe("export const a = 2;\n");
    expect(await readAtRevision(scope, "src/b.ts")).toBe("export const b = 1;\n");
  });

  it("compares with the nearest base, not the first one it finds", async () => {
    repo.git("checkout", "-q", "-b", "develop");
    repo.commit("develop work", { "src/d.ts": "export const d = 1;\n" });
    repo.git("checkout", "-q", "-b", "feature/from-develop");
    repo.commit("feature", { "src/f.ts": "export const f = 1;\n" });
    repo.git("checkout", "-q", "main");
    const scope = await resolveScope({
      cwd: repo.root,
      spec: { kind: "ref", ref: "feature/from-develop" },
    });
    expect(scope.label).toBe("feature/from-develop → develop");
    expect(scope.files.map((file) => file.path)).toEqual(["src/f.ts"]);
  });

  it("says so when the branch exists neither locally nor on origin", async () => {
    await expect(
      resolveScope({ cwd: repo.root, spec: { kind: "ref", ref: "nope/missing" } }),
    ).rejects.toThrow(/cannot find branch nope\/missing/);
  });
});
