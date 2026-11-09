import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { type ProvidersFile, type ResolvedConfig } from "@crit/schema";
import { loadProviders, type SqliteStore } from "@crit/store";
import { type CliContext, sessionsDir } from "@/shared/lib/cli-context.ts";
import { adapterFor } from "@/features/provider-setup/lib/adapter-for.ts";
import {
  createReviewSession,
  type ReviewSession,
} from "@/features/review-session/model/session.ts";
import { type Choice, type Switcher } from "@/features/model-switching/lib/create-switcher.ts";
import { type Editor, terminalEditor } from "@/shared/lib/terminal-editor.ts";

function runFor(ctx: CliContext, file: ProvidersFile, c: Choice): ProviderRun {
  const base = file.providers.find((p) => p.name === c.provider) ?? file.providers[0]!;
  const profile = { ...base, model: c.model, effort: c.effort };
  return { profile, adapter: adapterFor(ctx, profile) };
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
  const session = createReviewSession({
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
