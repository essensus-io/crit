import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  addedLines,
  agentRebaser,
  diffPath,
  type FixContext,
  type ProviderRun,
  parseUnifiedDiff,
  readAtRevision,
  resolveScope,
  runReview,
} from "@crit/core";
import { resolveProvider } from "@crit/providers";
import {
  formatTokens,
  type ProvidersFile,
  type ResolvedConfig,
  type ReviewEvent,
  shortId,
} from "@crit/schema";
import { listHistory, loadProviders, type SqliteStore } from "@crit/store";
import { render } from "ink";
import type { ReactElement } from "react";
import { type CliContext, sessionsDir } from "../context.ts";
import { adapterFor } from "../setup.ts";
import { ReviewApp, RunApp } from "./App.tsx";
import type { RunRecovery } from "./ProgressScreen.tsx";
import { Screen } from "./screen.tsx";
import { type Editor, ReviewSession } from "./session.ts";
import { type Choice, createSwitcher, type Switcher } from "./switcher.ts";

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

const ALT_SCROLL_ON = "\u001B[?1007h";
const ALT_SCROLL_OFF = "\u001B[?1007l";

/**
 * Render full screen: the terminal's alternate buffer (its own scrollback is
 * untouched and comes back on exit), a root exactly as tall as the window, and
 * wheel scrolling delivered as arrow keys. Nothing scrolls the outer terminal.
 */
export async function renderFullScreen(node: ReactElement): Promise<void> {
  const tty = Boolean(process.stdout.isTTY);
  if (tty) process.stdout.write(ALT_SCROLL_ON);
  const app = render(<Screen>{node}</Screen>, { alternateScreen: true });
  try {
    await app.waitUntilExit();
  } finally {
    app.unmount();
    if (tty) process.stdout.write(ALT_SCROLL_OFF);
  }
}

/** The one line left in the terminal after the screen closes. */
export async function summaryLine(
  store: SqliteStore,
  reviewId: string,
): Promise<string | undefined> {
  const review = await store.reviews.get(reviewId);
  if (!review) return undefined;
  const row = (await listHistory(store.db, { repoId: review.repoId, limit: 20 })).find(
    (r) => r.review.id === reviewId,
  );
  if (!row) return undefined;
  const findings = await store.findings.listByReview(reviewId);
  const shown = findings.filter((f) => f.verdict !== "rejected" && f.status !== "dismissed");
  const selected = shown.filter((f) => f.selected).length;
  const tokens = row.tokens.effective > 0 ? ` · ~${formatTokens(row.tokens.effective)} tokens` : "";
  const state = review.status === "partial" ? " (stopped early)" : "";
  const id = shortId(reviewId);
  return `crit review ${id}${state} · ${review.scopeLabel} · ${shown.length} findings, ${selected} selected${tokens} · crit open ${id} to come back\n`;
}

/** The provider run for a choice: the saved profile with this session's model and effort. */
function runFor(ctx: CliContext, file: ProvidersFile, c: Choice): ProviderRun {
  const base = file.providers.find((p) => p.name === c.provider) ?? file.providers[0]!;
  const profile = { ...base, model: c.model, effort: c.effort };
  return { profile, adapter: adapterFor(ctx, profile) };
}

export function makeSwitcher(
  ctx: CliContext,
  config: ResolvedConfig,
  initial: Partial<Choice> & { provider: string },
): Switcher | undefined {
  const file = loadProviders(ctx.paths);
  if (!file?.providers.length) return undefined;
  return createSwitcher(ctx, file, config, initial);
}

export async function makeSession(
  ctx: CliContext,
  store: SqliteStore,
  root: string,
  reviewId: string,
  config: ResolvedConfig,
  opts: { editor?: Editor; switcher?: Switcher } = {},
): Promise<ReviewSession> {
  const providers = loadProviders(ctx.paths);
  const review = await store.reviews.get(reviewId);
  // The code the findings are about, shown in place; works without a provider.
  const scope = review
    ? await resolveScope({
        cwd: root,
        spec: review.scope,
        ignore: config.ignore,
        maxFileTokens: config.maxFileTokens,
      }).catch(() => undefined)
    : undefined;
  const read = async (p: string) =>
    scope ? readAtRevision(scope, p) : readFileSync(join(root, p), "utf8");
  const added = new Map(
    parseUnifiedDiff(scope?.diff ?? "").map((f) => [diffPath(f), addedLines(f)]),
  );
  let fixContext: FixContext | undefined;
  let recheck: ((file: string) => Promise<string>) | undefined;
  let rebase;
  if (providers?.providers.some((p) => p.enabled) && review) {
    // AI actions start on the evaluate role; the switcher moves them to what the user picks.
    const evaluator = resolveProvider(providers, { role: "evaluate" }).profile;
    const holder = {
      run: { profile: evaluator, adapter: adapterFor(ctx, evaluator) } as ProviderRun,
    };
    fixContext = {
      store,
      provider: holder.run,
      root,
      config,
      read,
    };
    rebase = (...args: Parameters<ReturnType<typeof agentRebaser>>) =>
      agentRebaser(holder.run, root, config)(...args);
    recheck = async (file) => {
      const r = await runReview({
        cwd: root,
        spec: { kind: "paths", paths: [file], diff: false },
        config,
        store,
        provider: holder.run,
        sessionsDir: sessionsDir(ctx),
        mcpCommand: ctx.mcpCommand,
        home: ctx.home,
        configDir: ctx.paths.config,
        useCache: false,
      });
      return r.review.id;
    };
    opts.switcher?.subscribe((c) => {
      holder.run = runFor(ctx, providers, c);
      fixContext!.provider = holder.run;
      config.depth = c.depth;
    });
  }
  const session = new ReviewSession({
    store,
    root,
    reviewId,
    editor: opts.editor ?? terminalEditor(ctx.env),
    code: {
      read: async (p) => {
        const text = await read(p);
        if (text === undefined) throw new Error(`cannot read ${p}`);
        return text;
      },
      added: (f) => added.get(f) ?? new Set<number>(),
    },
    backupRoot: join(ctx.paths.cache, "backups"),
    verifyCommands: config.verify.commands,
    ...(fixContext ? { fixContext } : {}),
    ...(rebase ? { rebase } : {}),
    ...(recheck ? { recheck } : {}),
  });
  await session.load();
  if (review && fixContext) {
    // Tell the user once if their agent CLI is newer or older than what crit was tested with.
    void ctx.registry
      .create(fixContext.provider.profile, { env: ctx.env, tmpDir: ctx.paths.cache })
      .detect()
      .then((d) => {
        if (d.installed && d.untestedVersion)
          session.notify(
            `${fixContext.provider.profile.name} ${d.version ?? ""} has not been tested with this crit version; if something misbehaves, run crit doctor.`,
          );
      })
      .catch(() => undefined);
  }
  return session;
}

/** `crit open` in a terminal: the review screen for a saved review. */
export async function openTui(
  ctx: CliContext,
  store: SqliteStore,
  root: string,
  reviewId: string,
  config: ResolvedConfig,
): Promise<Choice | undefined> {
  const review = await store.reviews.get(reviewId);
  const switcher = review ? makeSwitcher(ctx, config, { provider: review.provider }) : undefined;
  const session = await makeSession(
    ctx,
    store,
    root,
    reviewId,
    config,
    switcher ? { switcher } : {},
  );
  let rerun: Choice | undefined;
  await renderFullScreen(
    <ReviewApp
      session={session}
      {...(switcher ? { switcher } : {})}
      onRerun={() => {
        rerun = switcher?.current() ?? {
          provider: "",
          model: null,
          effort: null,
          depth: config.depth,
        };
      }}
    />,
  );
  if (rerun) return rerun;
  const line = await summaryLine(store, reviewId);
  if (line) ctx.out(line);
  return undefined;
}

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
