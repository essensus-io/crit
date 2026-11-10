import { afterEach, describe, expect, it } from "vitest";
import { createGithubLink } from "@/features/github-link/lib/create-github-link.ts";
import { type TestEnv, testContext } from "./helpers.ts";

let t: TestEnv;
afterEach(() => t.cleanup());

const withAuth = (signedIn: () => boolean) => {
  t = testContext();
  t.ctx.gh = async () =>
    signedIn()
      ? { stdout: "✓ Logged in to github.com account octocat (keyring)\n", stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "You are not logged into any GitHub hosts.", exitCode: 1 };
  return createGithubLink(t.ctx, t.dir);
};

describe("github link", () => {
  it("reports the account when gh is signed in and does not log in again", async () => {
    const link = withAuth(() => true);
    expect(await link.connect(undefined)).toBe("GitHub is connected as octocat.");
    expect(t.loginCount()).toBe(0);
    expect(link.hint()).toBe("connected as octocat");
  });

  it("runs gh auth login when signed out and reports the result", async () => {
    let signedIn = false;
    const link = withAuth(() => signedIn);
    t.ctx.loginToGithub = async () => {
      signedIn = true;
      return 0;
    };
    expect(await link.connect(undefined)).toContain("connected as octocat");
  });

  it("says so when the login did not finish", async () => {
    const link = withAuth(() => false);
    expect(await link.connect(undefined)).toContain("was not connected");
  });
});

describe("github status with several saved accounts", () => {
  it("reads the active account even when gh auth status fails for another one", async () => {
    t = testContext();
    t.ctx.gh = async (_cwd, args) =>
      args.includes("--active")
        ? {
            stdout: "✓ Logged in to github.com account octocat (keyring)\n",
            stderr: "",
            exitCode: 0,
          }
        : { stdout: "", stderr: "X Failed to log in to github.com account old", exitCode: 1 };
    expect(createGithubLink(t.ctx, t.dir).hint()).toBe("checking…");
    expect(await createGithubLink(t.ctx, t.dir).connect(undefined)).toBe(
      "GitHub is connected as octocat.",
    );
  });

  it("falls back to plain gh auth status on an older gh without --active", async () => {
    t = testContext();
    t.ctx.gh = async (_cwd, args) =>
      args.includes("--active")
        ? { stdout: "", stderr: "unknown flag: --active", exitCode: 1 }
        : { stdout: "✓ Logged in to github.com account octocat\n", stderr: "", exitCode: 0 };
    expect(await createGithubLink(t.ctx, t.dir).connect(undefined)).toBe(
      "GitHub is connected as octocat.",
    );
  });
});
