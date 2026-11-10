import { join } from "node:path";
import { agentRebaser, applyFixes, type ApplyTarget, plannedFixes } from "@crit/core";
import { resolveProvider } from "@crit/providers";
import { resolveConfig, shortId } from "@crit/schema";
import { loadProjectConfig, loadProviders, loadUserConfig } from "@crit/store";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { EXIT } from "@/shared/lib/errors.ts";
import { adapterFor } from "@/features/provider-setup/lib/adapter-for.ts";
import { colors } from "@/shared/lib/colors.ts";
import { duration, plural } from "@/shared/lib/format.ts";
import { resolveReview } from "@/features/review-session/lib/resolve-review.ts";
import { repoRootOrThrow } from "@/shared/lib/repo-root-or-throw.ts";

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
    for (const command of result.verify.commands)
      ctx.out(
        `  ${command.exitCode === 0 ? c.green("✓") : c.red("✗")} ${command.command} ${c.dim(duration(command.durationMs))}\n`,
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
