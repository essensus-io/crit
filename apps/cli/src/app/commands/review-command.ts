import { defineCommand } from "citty";
import { type CliContext } from "@/shared/lib/cli-context.ts";
import { type ReviewArgs } from "@/app/runners/review/review-args.ts";
import { runReviewCommand } from "@/app/runners/review/run-review-command.ts";

export const reviewCommand = (ctx: CliContext) =>
  defineCommand({
    meta: {
      name: "review",
      description:
        "Review the current branch (default), paths, staged changes, a commit, or the whole project",
    },
    args: {
      paths: {
        type: "positional",
        required: false,
        description: "Paths, folders or globs to review",
      },
      all: { type: "boolean", description: "Review the whole project (sharded; asks to confirm)" },
      staged: { type: "boolean", description: "Review staged changes" },
      commit: { type: "string", description: "Review one commit" },
      branch: {
        type: "string",
        description:
          "Review another branch or a GitHub PR link without checking it out (comments only)",
      },
      base: { type: "string", description: "Base branch for branch reviews" },
      diff: { type: "boolean", description: "With paths: only files changed versus the base" },
      provider: { type: "string", description: "Provider profile to use for this run" },
      budget: {
        type: "string",
        description: "Stop after this many effective tokens, e.g. 500k or 2M (default 2M)",
      },
      "dry-run": {
        type: "boolean",
        description: "Show the files, skipped files, runs and token estimate; call no agent",
      },
      "max-shards": {
        type: "string",
        description: "Maximum shards approved for this run (overrides the configured budget)",
      },
      model: { type: "string", description: "Model for this run, e.g. opus or gpt-6-sol" },
      effort: { type: "string", description: "Reasoning effort for this run (low … max)" },
      depth: {
        type: "string",
        description:
          "quick (core lenses, no skeptic), standard (default) or deep (split lenses, check all)",
      },
      lens: { type: "string", description: "Limit to lenses, e.g. security,performance" },
      tui: {
        type: "boolean",
        default: true,
        description: "Open the interactive review screen (--no-tui prints a report)",
      },
      format: { type: "string", description: "Output format with --no-tui: json, md or sarif" },
      output: { type: "string", alias: "o", description: "Write the report to a file" },
      yes: {
        type: "boolean",
        alias: "y",
        description: "Skip the confirmation (whole-project and large reviews)",
      },
      verify: {
        type: "boolean",
        default: true,
        description: "Run the skeptic pass (--no-verify skips it)",
      },
      cache: {
        type: "boolean",
        default: true,
        description: "Reuse cached results for unchanged files",
      },
      gh: {
        type: "boolean",
        alias: "pr",
        description:
          "Run without the screen and post every open finding to this branch's GitHub PR (needs gh)",
      },
      "fail-on": {
        type: "string",
        description: "Exit 3 if a finding at or above this severity is found",
      },
    },
    run: async ({ args }) => {
      process.exitCode = await runReviewCommand(ctx, args as unknown as ReviewArgs);
    },
  });
