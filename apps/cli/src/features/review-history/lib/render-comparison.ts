import { type Finding, type Review, shortId } from "@crit/schema";
import { type Comparison } from "@crit/store";
import { colors } from "@/shared/lib/colors.ts";
import { truncate } from "@/shared/lib/text.ts";

export function renderComparison(
  c: Comparison & { older: Review; newer: Review },
  opts: { color: boolean; full?: boolean },
): string {
  const col = colors(opts.color);
  const titles = (list: Finding[]) =>
    opts.full ? "" : truncate(list.map((f) => f.title).join(" · "), 70);
  const out = [
    `  ${col.dim(`${shortId(c.older.id)} → ${shortId(c.newer.id)} · ${c.newer.scopeLabel}`)}`,
    "",
    `  ${col.green("fixed".padEnd(11))} ${String(c.fixed.length).padStart(3)}   ${titles(c.fixed)}`,
    `  ${col.yellow("new".padEnd(11))} ${String(c.new.length).padStart(3)}   ${titles(c.new)}`,
    `  ${"still open".padEnd(11)} ${String(c.stillOpen.length).padStart(3)}   ${opts.full ? "" : c.stillOpen.length ? col.dim("--list to show them") : ""}`,
  ];
  if (opts.full) {
    for (const [label, list] of [
      ["fixed", c.fixed],
      ["new", c.new],
      ["still open", c.stillOpen],
    ] as const) {
      if (!list.length) continue;
      out.push("", `  ${col.bold(label)}`);
      for (const f of list) out.push(`    ${f.file}:${f.range.start}  ${f.title}`);
    }
  }
  return `${out.join("\n")}\n`;
}
