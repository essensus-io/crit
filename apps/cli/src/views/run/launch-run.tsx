import { type ResolvedConfig, type ReviewEvent } from "@crit/schema";
import { type SqliteStore } from "@crit/store";
import { type CliContext } from "@/shared/lib/cli-context.ts";
import { RunView } from "./run-view.tsx";
import type { RunRecovery } from "@/features/run-progress/lib/progress-state.ts";
import { type Choice } from "@/features/model-switching/lib/create-switcher.ts";
import { makeSession } from "@/views/review/make-session.ts";
import { makeSwitcher } from "@/features/model-switching/lib/make-switcher.ts";
import { renderFullScreen } from "@/shared/ui/render-full-screen.tsx";
import { summaryLine } from "@/features/review-session/lib/summary-line.ts";

export const runTui = async (
  ctx: CliContext,
  store: SqliteStore,
  root: string,
  config: ResolvedConfig,
  start: (onEvent: (e: ReviewEvent) => void, signal: AbortSignal) => Promise<unknown>,
  initial?: Partial<Choice> & { provider: string },
): Promise<RunRecovery | undefined> => {
  const listeners = new Set<(e: ReviewEvent) => void>();
  let recovery: RunRecovery | undefined;
  let reviewId: string | undefined;
  const ac = new AbortController();
  const switcher = initial ? makeSwitcher(ctx, config, initial) : undefined;
  const ui = renderFullScreen(
    <RunView
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
  if (recovery && process.stdin.isTTY) process.stdin.ref();
  if (!recovery && reviewId) {
    const line = await summaryLine(store, reviewId);
    if (line) ctx.out(line);
  }
  return recovery;
};
