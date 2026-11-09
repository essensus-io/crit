import { ruleLabel, type RuleSet } from "@crit/core";
import { colors } from "@/shared/lib/colors.ts";
import { plural } from "@/shared/lib/format.ts";
import { table } from "@/shared/lib/table.ts";

export function renderRules(set: RuleSet, c: ReturnType<typeof colors>, all: boolean): string {
  const out: string[] = [];
  const regular = set.all.filter((r) => r.kind !== "skill" && r.kind !== "claude-agent");
  if (regular.length === 0 && set.skills.length === 0)
    out.push("No rules found. Add CLAUDE.md, AGENTS.md, .cursor/rules or .crit/rules/*.md.");
  if (regular.length) {
    const rows = [
      [c.dim("ID"), c.dim("LAYER"), c.dim("APPLIES TO"), c.dim("RULE"), c.dim("SOURCE")],
    ];
    for (const r of regular) {
      const applies = r.alwaysApply
        ? "always"
        : r.globs.length
          ? r.globs.join(", ")
          : r.scopeDir
            ? `${r.scopeDir}/**`
            : "all files";
      rows.push([r.id, r.layer, applies, r.title, c.dim(ruleLabel(r))]);
    }
    out.push(c.bold(`Rules (${regular.length})`), table(rows));
  }
  if (set.skills.length) {
    out.push("", c.bold(`Skills and agents (${set.skills.length}, listed by name for the agent)`));
    out.push(
      table(
        set.skills.map((skill) => [
          skill.id,
          skill.title,
          c.dim(skill.description ?? ""),
          c.dim(skill.path),
        ]),
      ),
    );
  }
  if (set.conflicts.length) {
    out.push("", c.yellow(c.bold(`Conflicts (${set.conflicts.length})`)));
    for (const ruleConflict of set.conflicts)
      out.push(
        `  "${ruleConflict.topic}": ${ruleConflict.winner} wins over ${ruleConflict.ruleIds.filter((ruleId) => ruleId !== ruleConflict.winner).join(", ")} (user > project > global)`,
      );
  }
  if (set.filtered.length) {
    out.push(
      "",
      c.dim(
        `${plural(set.filtered.length, "section")} skipped as not about review${all ? ":" : " (crit rules --all to list)"}`,
      ),
    );
    if (all) for (const r of set.filtered) out.push(c.dim(`  - ${ruleLabel(r)}`));
  }
  if (set.errors.length) {
    out.push("", c.red(c.bold("Errors")));
    for (const error of set.errors) out.push(c.red(`  ${error}`));
  }
  return `${out.join("\n")}\n`;
}
