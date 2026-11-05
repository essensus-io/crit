import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { agentRebaser, type FixContext, readAtRevision, resolveScope, runReview } from "@crit/core";
import { resolveProvider } from "@crit/providers";
import type { ResolvedConfig, ReviewEvent } from "@crit/schema";
import { loadProviders, type SqliteStore } from "@crit/store";
import { render } from "ink";
import { type CliContext, sessionsDir } from "../context.ts";
import { adapterFor } from "../setup.ts";
import { ReviewApp, RunApp } from "./App.tsx";
import type { RunRecovery } from "./ProgressScreen.tsx";
import { type Editor, ReviewSession } from "./session.ts";

/** $VISUAL / $EDITOR on a temp copy of the file (same name, so editors pick the right syntax). */
export function terminalEditor(env: NodeJS.ProcessEnv): Editor {
  return async (content, filename) => {
    const dir = mkdtempSync(join(tmpdir(), "crit-edit-"));
    const file = join(dir, basename(filename));
    writeFileSync(file, content);
    try {
      const editor = env.VISUAL || env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
      const r = spawnSync(editor, [file], { stdio: "inherit", shell: true });
      if (r.status !== 0) return undefined;
      const edited = readFileSync(file, "utf8");
      return edited === content ? undefined : edited;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

export async function makeSession(
  ctx: CliContext,
  store: SqliteStore,
  root: string,
  reviewId: string,
  config: ResolvedConfig,
  editor?: Editor,
): Promise<ReviewSession> {
  const providers = loadProviders(ctx.paths);
  const review = await store.reviews.get(reviewId);
  let fixContext: FixContext | undefined;
  let recheck: ((file: string) => Promise<string>) | undefined;
  let rebase;
  if (providers?.providers.some((p) => p.enabled) && review) {
    const evaluator = resolveProvider(providers, { role: "evaluate" }).profile;
    const run = { profile: evaluator, adapter: adapterFor(ctx, evaluator) };
    const scope = await resolveScope({
      cwd: root,
      spec: review.scope,
      ignore: config.ignore,
      maxFileTokens: config.maxFileTokens,
    }).catch(() => undefined);
    fixContext = {
      store,
      provider: run,
      root,
      config,
      read: async (p) => (scope ? readAtRevision(scope, p) : readFileSync(join(root, p), "utf8")),
    };
    rebase = agentRebaser(run, root, config);
    const reviewer = resolveProvider(providers, { name: review.provider }).profile;
    recheck = async (file) => {
      const r = await runReview({
        cwd: root,
        spec: { kind: "paths", paths: [file], diff: false },
        config,
        store,
        provider: { profile: reviewer, adapter: adapterFor(ctx, reviewer) },
        sessionsDir: sessionsDir(ctx),
        mcpCommand: ctx.mcpCommand,
        home: ctx.home,
        configDir: ctx.paths.config,
        useCache: false,
      });
      return r.review.id;
    };
  }
  const session = new ReviewSession({
    store,
    root,
    reviewId,
    editor: editor ?? terminalEditor(ctx.env),
    backupRoot: join(ctx.paths.cache, "backups"),
    verifyCommands: config.verify.commands,
    ...(fixContext ? { fixContext } : {}),
    ...(rebase ? { rebase } : {}),
    ...(recheck ? { recheck } : {}),
  });
  await session.load();
  return session;
}

/** `crit open` in a terminal: the review screen for a saved review. */
export async function openTui(
  ctx: CliContext,
  store: SqliteStore,
  root: string,
  reviewId: string,
  config: ResolvedConfig,
): Promise<void> {
  const session = await makeSession(ctx, store, root, reviewId, config);
  const app = render(<ReviewApp session={session} />);
  await app.waitUntilExit();
}

/** `crit review` in a terminal: progress, then the review screen. Returns when the user quits. */
export async function runTui(
  ctx: CliContext,
  store: SqliteStore,
  root: string,
  config: ResolvedConfig,
  start: (onEvent: (e: ReviewEvent) => void, signal: AbortSignal) => Promise<unknown>,
): Promise<RunRecovery | undefined> {
  const listeners = new Set<(e: ReviewEvent) => void>();
  let recovery: RunRecovery | undefined;
  const ac = new AbortController();
  const app = render(
    <RunApp
      subscribe={(fn) => {
        listeners.add(fn);
        return () => void listeners.delete(fn);
      }}
      makeSession={(id) => makeSession(ctx, store, root, id, config)}
      onStop={() => ac.abort()}
      onRecover={(action) => {
        recovery = action;
        ac.abort();
      }}
    />,
  );
  const running = start((e) => {
    for (const l of listeners) l(e);
  }, ac.signal).catch(() => undefined);
  await app.waitUntilExit();
  app.unmount();
  ac.abort();
  await running;
  // Ink unreferences stdin when it releases raw mode. Readline (used by the
  // provider prompts) resumes that stream but does not reference it again,
  // so Node can exit while the next prompt is still awaiting an answer.
  if (recovery && process.stdin.isTTY) process.stdin.ref();
  return recovery;
}
