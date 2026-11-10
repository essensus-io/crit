import { ghStatus, type GhStatus } from "@crit/core";
import type { CliContext } from "@/shared/lib/cli-context.ts";

export type GithubLink = {
  hint: () => string;
  refresh: () => Promise<void>;
  connect: (suspend: ((fn: () => Promise<void>) => Promise<void>) | undefined) => Promise<string>;
  subscribe: (listener: () => void) => () => void;
};

const MISSING_NOTICE =
  "The GitHub CLI (gh) is not installed. Get it from https://cli.github.com, then press g again.";

export const describeGhStatus = (status: GhStatus | undefined): string => {
  if (!status) return "checking…";
  if (status.kind === "connected")
    return status.account ? `connected as ${status.account}` : "connected";
  if (status.kind === "missing") return "gh not installed";
  return "not connected · enter to connect";
};

export const createGithubLink = (ctx: CliContext, root: string): GithubLink => {
  let status: GhStatus | undefined;
  const listeners = new Set<() => void>();
  const check = async (): Promise<GhStatus> => {
    status = await ghStatus(ctx.gh, root);
    for (const listener of listeners) listener();
    return status;
  };
  let loginExitCode = 0;
  const login = async () => {
    loginExitCode = await ctx.loginToGithub();
  };
  const connect: GithubLink["connect"] = async (suspend) => {
    const before = await check();
    if (before.kind === "missing") return MISSING_NOTICE;
    if (before.kind === "connected") return `GitHub is ${describeGhStatus(before)}.`;
    await (suspend ? suspend(login) : login());
    const after = await check();
    return after.kind === "connected"
      ? `GitHub ${describeGhStatus(after)}. c ticks findings, s posts them to the PR.`
      : `GitHub was not connected (gh auth login exited with ${loginExitCode}). Run it in a terminal and try again.`;
  };
  return {
    hint: () => describeGhStatus(status),
    refresh: async () => void (await check()),
    connect,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
