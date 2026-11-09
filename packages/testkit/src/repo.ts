import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type FixtureRepo = {
  root: string;
  git(...args: string[]): string;
  write(files: Record<string, string>): void;
  remove(...paths: string[]): void;
  commit(message: string, files?: Record<string, string>): string;
  cleanup(): void;
};

const GIT_ENV = {
  GIT_AUTHOR_NAME: "crit test",
  GIT_AUTHOR_EMAIL: "test@crit.local",
  GIT_COMMITTER_NAME: "crit test",
  GIT_COMMITTER_EMAIL: "test@crit.local",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
};

export const gitTestEnv = (): NodeJS.ProcessEnv => ({ ...process.env, ...GIT_ENV });

export function createFixtureRepo(initial?: Record<string, string>): FixtureRepo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "crit-fixture-")));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, env: gitTestEnv(), encoding: "utf8" }).trimEnd();
  const write = (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      const abs = join(root, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
  };
  const remove = (...paths: string[]) => {
    for (const path of paths) rmSync(join(root, path), { force: true, recursive: true });
  };
  const commit = (message: string, files?: Record<string, string>) => {
    if (files) write(files);
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  git("config", "core.autocrlf", "false");
  if (initial) commit("initial", initial);
  return {
    root,
    git,
    write,
    remove,
    commit,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
