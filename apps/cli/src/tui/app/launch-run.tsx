import { type ResolvedConfig, type ReviewEvent } from "@crit/schema";
import { type SqliteStore } from "@crit/store";
import { type CliContext } from "../../context.ts";
import { RunApp } from "../views/run/index.ts";
import type { RunRecovery } from "../features/run-progress/index.ts";
import { type Choice } from "../features/model-switching/index.ts";
import { makeSession } from "./make-session.ts";
import { makeSwitcher } from "./make-switcher.ts";
import { renderFullScreen } from "./render-full-screen.tsx";
import { summaryLine } from "./summary-line.ts";

/**
 * `crit review` in a terminal: the run dashboard, then the review screen.
 * Returns what the user asked for when leaving (retry, connect a provider…).
 */
export async function runTui(
  ctx: CliContext,
  store: SqliteStore,
  root: string,
  config: ResolvedConfig,
  start: (onEvent: (e: ReviewEvent) => void, signal: AbortSignal) => Promise<unknown>,
  initial?: Partial<Choice> & { provider: string },
): Promise<RunRecovery | undefined> {
  const listeners = new Set<(e: ReviewEvent) => void>();
  let recovery: RunRecovery | undefined;
  let reviewId: string | undefined;
  const ac = new AbortController();
  const switcher = initial ? makeSwitcher(ctx, config, initial) : undefined;
  const ui = renderFullScreen(
    <RunApp
      subscribe={(fn) => {
        listeners.add(fn);
        return () => void listeners.delete(fn);
      }}
      makeSession={(id) => makeSession(ctx, store, root, id, config, switcher ? { switcher } : {})}
      onStop={() => ac.abort()}
      onRecover={(action) => {
        recovery = action;
        ac.abort();
      }}
      {...(switcher ? { switcher } : {})}
    />,
  );
  const running = start((e) => {
    if (e.type === "review-started") reviewId = e.reviewId;
    for (const l of listeners) l(e);
  }, ac.signal).catch(() => undefined);
  await ui;
  ac.abort();
  await running;
  // Ink unreferences stdin when it releases raw mode. Readline (used by the
  // provider prompts) resumes that stream but does not reference it again,
  // so Node can exit while the next prompt is still awaiting an answer.
  if (recovery && process.stdin.isTTY) process.stdin.ref();
  if (!recovery && reviewId) {
    const line = await summaryLine(store, reviewId);
    if (line) ctx.out(line);
  }
  return recovery;
}
