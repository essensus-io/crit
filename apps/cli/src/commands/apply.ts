import { join } from "node:path";
import { agentRebaser, applyFixes, type ApplyTarget, plannedFixes, undoApply } from "@crit/core";
import { resolveProvider } from "@crit/providers";
import { resolveConfig, shortId } from "@crit/schema";
import {
  exportReview,
  listHistory,
  loadProjectConfig,
  loadProviders,
  loadUserConfig,
} from "@crit/store";
import { defineCommand } from "citty";
import type { CliContext } from "../context.ts";
import { CliError, EXIT } from "../shared/lib/errors.ts";
import { textReport } from "../report.ts";
import { adapterFor } from "../setup.ts";
import { colors, duration, plural } from "../ui.ts";
import { resolveReview } from "./resolve.ts";
import { repoRootOrThrow } from "./shared.ts";

export async function applyCommand(
  ctx: CliContext,
  args: {
    review?: string;
    branch?: boolean;
    "branch-name"?: string;
    squash?: boolean;
    yes?: boolean;
    verify?: boolean;
  },
): Promise<number> {
  const root = await repoRootOrThrow(ctx.cwd);
  const store = ctx.openStore();
  const review = await resolveReview(ctx, store, root, args.review);
  const planned = await plannedFixes(store, review.id);
  const c = colors(ctx.color);
  if (planned.length === 0) {
    ctx.out(`No checked fixes in review ${shortId(review.id)}.\n`);
    return EXIT.ok;
  }
  const branchName = args["branch-name"];
  const target: ApplyTarget =
    args.branch || branchName
      ? {
          kind: "branch",
          squash: Boolean(args.squash),
          ...(branchName ? { name: branchName } : {}),
        }
      : { kind: "worktree" };
  ctx.out(
    `${c.bold(`Applying ${plural(planned.length, "fix", "fixes")} from review ${shortId(review.id)}`)} → ${target.kind === "branch" ? `branch ${target.name ?? `crit/fixes-${shortId(review.id)}`}` : "working tree"}\n`,
  );
  for (const p of planned)
    ctx.out(`  ${p.finding.file}:${p.finding.range.start}  ${p.finding.title}\n`);
  if (
    !args.yes &&
    ctx.interactive &&
    !(await ctx.prompter.confirm({ message: "Apply these fixes?", initialValue: true }))
  )
    return EXIT.cancelled;

  const config = resolveConfig(loadUserConfig(ctx.paths), loadProjectConfig(root));
  const providers = loadProviders(ctx.paths);
  let rebase;
  if (providers?.providers.length) {
    const { profile } = resolveProvider(providers, { role: "evaluate" });
    rebase = agentRebaser({ profile, adapter: adapterFor(ctx, profile) }, root, config);
  }
  const result = await applyFixes({
    store,
    reviewId: review.id,
    root,
    target,
    backupRoot: join(ctx.paths.cache, "backups"),
    ...(args.verify !== false && config.verify.commands.length
      ? { verifyCommands: config.verify.commands }
      : {}),
    ...(rebase ? { rebase } : {}),
  });
  if (result.overlaps.length)
    ctx.out(
      c.yellow(
        `${plural(result.overlaps.length, "overlap")} between fixes; later ones were rebased by the agent where needed.\n`,
      ),
    );
  for (const a of result.applied)
    ctx.out(
      `${c.green("✓")} ${a.finding.file}:${a.finding.range.start}  ${a.finding.title}${result.rebased.includes(a.finding.id) ? c.dim(" (rebased)") : ""}\n`,
    );
  for (const s of result.skipped)
    ctx.out(
      `${c.red("✗")} ${s.finding.file}:${s.finding.range.start}  ${s.finding.title} · ${s.reason}\n`,
    );
  if (result.verify) {
    for (const v of result.verify.commands)
      ctx.out(
        `  ${v.exitCode === 0 ? c.green("✓") : c.red("✗")} ${v.command} ${c.dim(duration(v.durationMs))}\n`,
      );
    if (!result.verify.passed)
      ctx.out(
        c.red(
          `${result.verify.commands.at(-1)!.output.trim().split("\n").slice(-15).join("\n")}\n`,
        ),
      );
  }
  if (result.branch) ctx.out(`Committed to ${result.branch}. Your working tree was not changed.\n`);
  else if (result.applied.length)
    ctx.out(c.dim(`Backup saved; \`crit undo\` restores the files.\n`));
  return result.skipped.length || result.verify?.passed === false ? EXIT.error : EXIT.ok;
}

export async function undoCommand(ctx: CliContext, args: { force?: boolean }): Promise<number> {
  const root = await repoRootOrThrow(ctx.cwd);
  const store = ctx.openStore();
  const repo = await store.repos.getByRoot(root);
  if (!repo) throw new CliError("crit: nothing to undo in this repository");
  const ids = (await listHistory(store.db, { repoId: repo.id, limit: 50 })).map((r) => r.review.id);
  try {
    const r = await undoApply({ store, reviewIds: ids, root, force: Boolean(args.force) });
    if (r.branchDeleted) ctx.out(`Deleted branch ${r.branchDeleted}\n`);
    else
      ctx.out(
        `Restored ${plural(r.restored.length, "file")}${r.removed.length ? `, removed ${plural(r.removed.length, "new file")}` : ""} (review ${shortId(r.reviewId)})\n`,
      );
    return EXIT.ok;
  } catch (err) {
    throw new CliError((err as Error).message);
  }
}

export async function openCommand(
  ctx: CliContext,
  args: { review?: string; tui?: boolean },
): Promise<number> {
  const root = await repoRootOrThrow(ctx.cwd);
  const store = ctx.openStore();
  const review = await resolveReview(ctx, store, root, args.review);
  if (ctx.interactive && args.tui !== false) {
    const { openTui } = await import("../views/review/launch-review.tsx");
    const rerun = await openTui(
      ctx,
      store,
      root,
      review.id,
      resolveConfig(loadUserConfig(ctx.paths), loadProjectConfig(root)),
      { home: true },
    );
    if (!rerun) return EXIT.ok;
    const { argsFromScope, runReviewCommand } = await import("./review.ts");
    if (rerun === "home") return runReviewCommand(ctx, { _: [] });
    return runReviewCommand(ctx, {
      ...argsFromScope(review.scope),
      ...(rerun.provider ? { provider: rerun.provider } : {}),
      ...(rerun.model ? { model: rerun.model } : {}),
      ...(rerun.effort ? { effort: rerun.effort } : {}),
      depth: rerun.depth,
      cache: !rerun.fresh,
    });
  }
  ctx.out(textReport(await exportReview(store, review.id), { color: ctx.color }));
  return EXIT.ok;
}

export const applyDef = (ctx: CliContext) =>
  defineCommand({
    meta: { name: "apply", description: "Apply all checked fixes of a review (latest by default)" },
    args: {
      review: { type: "positional", required: false, description: "Review id (latest by default)" },
      branch: {
        type: "boolean",
        description: "Commit to a new branch crit/fixes-<id> instead of the working tree",
      },
      "branch-name": {
        type: "string",
        description: "Name for the fixes branch (implies --branch)",
      },
      squash: {
        type: "boolean",
        description: "With --branch: one commit instead of one per finding",
      },
      yes: { type: "boolean", alias: "y" },
      verify: { type: "boolean", default: true, description: "Run verify.commands after applying" },
    },
    run: async ({ args }) => {
      process.exitCode = await applyCommand(ctx, args as never);
    },
  });

export const undoDef = (ctx: CliContext) =>
  defineCommand({
    meta: { name: "undo", description: "Undo the last crit apply" },
    args: {
      force: { type: "boolean", description: "Restore even if files changed after applying" },
    },
    run: async ({ args }) => {
      process.exitCode = await undoCommand(ctx, args);
    },
  });

export const openDef = (ctx: CliContext) =>
  defineCommand({
    meta: { name: "open", description: "Reopen a saved review (latest by default)" },
    args: {
      review: { type: "positional", required: false },
      tui: {
        type: "boolean",
        default: true,
        description: "Open the review screen (--no-tui prints the report)",
      },
    },
    run: async ({ args }) => {
      process.exitCode = await openCommand(ctx, args);
    },
  });
