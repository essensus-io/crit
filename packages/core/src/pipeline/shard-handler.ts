import type { RuleView, SessionHandler } from "@crit/mcp";
import type { Shard } from "@crit/schema";
import type { ReviewRun } from "./review-run.ts";
import type { ShardReport, ShardState } from "./report-shard-finding.ts";

export const createShardHandler = (
  run: ReviewRun,
  shard: Shard,
  report: ShardReport,
  state: ShardState,
): SessionHandler => {
  const { scope, rules } = run.prepared;
  return {
    getScope: async () => {
      state.toolCalls++;
      return {
        label: scope.label,
        files: scope.files
          .filter((file) => shard.files.includes(file.path))
          .map((file) => ({
            path: file.path,
            status: file.status,
            ...(file.hunks ? { hunks: file.hunks } : {}),
          })),
        notes: scope.diff
          ? "Report on the changed lines of these files."
          : "Report on any line of these files.",
      };
    },
    getRules: async (ids) => {
      state.toolCalls++;
      const pool = [...rules.listed, ...rules.native, ...rules.attached, ...rules.skills];
      return pool
        .filter((rule) => !ids || ids.includes(rule.id))
        .map((rule): RuleView => ({
          id: rule.id,
          title: rule.title,
          path: rule.path,
          body: rule.body,
        }));
    },
    reportFinding: (finding) => {
      state.toolCalls++;
      return report(finding, true);
    },
    finish: async (input) => {
      state.toolCalls++;
      state.summary = input.coverage
        ? `${input.summary}\n\nNot covered: ${input.coverage}`
        : input.summary;
      return { ok: true };
    },
  };
};
