import { type Finding, formatTokens, type Review, SEVERITY_ORDER, shortId } from "@crit/schema";
import {
  compareFindings,
  type Comparison,
  type HistoryRow,
  listHistory,
  type SqliteStore,
} from "@crit/store";
import { defineCommand } from "citty";
import type { CliContext } from "../context.ts";
import { CliError, EXIT } from "../shared/lib/errors.ts";
import { colors, plural, SEVERITY_LETTER, table, truncate, when } from "../ui.ts";
import { resolveReview } from "./resolve.ts";
import { repoRootOrThrow } from "./shared.ts";

export function parseAge(s: string): number {
  const m = /^(\d+)\s*([hdw])$/.exec(s.trim());
  if (!m)
    throw new CliError(`crit: cannot read "${s}"; use e.g. 90d, 12w or 24h`, {
      exitCode: EXIT.usage,
    });
  const n = Number(m[1]);
  return n * { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as "h" | "d" | "w"];
}

export function parseSince(s: string, now: number): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00`).getTime();
  return now - parseAge(s);
}

export const severitySummary = (r: HistoryRow) =>
  SEVERITY_ORDER.map((s) => `${r.severity[s]}${SEVERITY_LETTER[s]}`).join(" ");

export const tokensLabel = (r: HistoryRow) =>
  r.tokens.effective > 0 ? `~${formatTokens(r.tokens.effective)}` : "-";

export function outcomeOf(r: HistoryRow): string {
  const st = r.review.status;
  if (st === "superseded") return "superseded";
  if (st === "partial") return "partial (stopped early)";
  if (st === "running") return "running";
  if (st === "failed" || st === "cancelled") return st;
  const parts: string[] = [];
  if (r.outcome.applied) parts.push(`${r.outcome.applied} applied`);
  if (r.outcome.dismissed) parts.push(`${r.outcome.dismissed} dismissed`);
  if (parts.length === 0) return r.outcome.open ? "open" : "clean";
  return parts.join(", ");
}

export type HistoryArgs = {
  branch?: string;
  scope?: string;
  provider?: string;
  since?: string;
  "all-repos"?: boolean;
  limit?: string;
  json?: boolean;
};

export async function historyRows(
  ctx: CliContext,
  store: SqliteStore,
  args: HistoryArgs,
): Promise<HistoryRow[]> {
  let repoId: string | undefined;
  if (!args["all-repos"]) {
    const root = await repoRootOrThrow(ctx.cwd);
    repoId = (await store.repos.getByRoot(root))?.id;
    if (!repoId) return [];
  }
  return listHistory(store.db, {
    ...(repoId ? { repoId } : {}),
    ...(args.branch ? { branch: args.branch } : {}),
    ...(args.scope ? { scope: args.scope } : {}),
    ...(args.provider ? { provider: args.provider } : {}),
    ...(args.since ? { since: parseSince(args.since, ctx.now()) } : {}),
    limit: args.limit ? Number(args.limit) : 50,
  });
}

export function renderHistory(
  rows: HistoryRow[],
  opts: { now: number; color: boolean; allRepos?: boolean; cursor?: number },
): string {
  const c = colors(opts.color);
  const head = [
    "",
    c.dim("ID"),
    c.dim("WHEN"),
    ...(opts.allRepos ? [c.dim("REPO")] : []),
    c.dim("SCOPE"),
    c.dim("PROVIDER"),
    c.dim("FINDINGS"),
    c.dim("TOKENS"),
    c.dim("OUTCOME"),
  ];
  const body = rows.map((r, i) => {
    const scope = r.review.scopeLabel;
    return [
      i === opts.cursor ? "›" : " ",
      shortId(r.review.id),
      when(r.review.startedAt, opts.now),
      ...(opts.allRepos ? [r.repoName] : []),
      truncate(scope, 30),
      r.review.provider,
      severitySummary(r),
      tokensLabel(r),
      outcomeOf(r),
    ];
  });
  return `${table([head, ...body])}\n\n  ${c.dim("C critical · M major · m minor · n nit")}\n`;
}

export async function compareReviews(
  store: SqliteStore,
  a: Review,
  b: Review,
): Promise<Comparison & { older: Review; newer: Review }> {
  const [older, newer] = a.startedAt <= b.startedAt ? [a, b] : [b, a];
  const c = compareFindings(
    await store.findings.listByReview(older.id),
    await store.findings.listByReview(newer.id),
  );
  return { ...c, older, newer };
}

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

export async function historyCommand(
  ctx: CliContext,
  args: HistoryArgs & { compare?: boolean; list?: boolean; _?: string[]; tui?: boolean },
): Promise<number> {
  const store = ctx.openStore();
  if (args.compare) {
    const [a, b] = args._ ?? [];
    if (!a || !b)
      throw new CliError("crit: --compare takes two review ids", {
        exitCode: EXIT.usage,
        hint: "crit history --compare 9c2e a41f",
      });
    const root = await repoRootOrThrow(ctx.cwd);
    const ra = await resolveReview(ctx, store, root, a);
    const rb = await resolveReview(ctx, store, root, b);
    const cmp = await compareReviews(store, ra, rb);
    if (args.json)
      ctx.out(
        `${JSON.stringify({ older: cmp.older.id, newer: cmp.newer.id, fixed: cmp.fixed, new: cmp.new, stillOpen: cmp.stillOpen }, null, 2)}\n`,
      );
    else ctx.out(renderComparison(cmp, { color: ctx.color, full: Boolean(args.list) }));
    return EXIT.ok;
  }
  const rows = await historyRows(ctx, store, args);
  if (args.json) {
    ctx.out(
      `${JSON.stringify(
        rows.map((r) => ({ ...r, outcomeLabel: outcomeOf(r) })),
        null,
        2,
      )}\n`,
    );
    return EXIT.ok;
  }
  if (rows.length === 0) {
    ctx.out("No reviews yet. Run `crit review`.\n");
    return EXIT.ok;
  }
  if (ctx.interactive && args.tui !== false) {
    const { historyTui } = await import("../views/history/launch-history.tsx");
    await historyTui(ctx, store, rows, args);
    return EXIT.ok;
  }
  ctx.out(
    `\n${renderHistory(rows, { now: ctx.now(), color: ctx.color, allRepos: Boolean(args["all-repos"]) })}`,
  );
  return EXIT.ok;
}

export async function removeReview(ctx: CliContext, ref: string, yes?: boolean): Promise<number> {
  const store = ctx.openStore();
  const root = await repoRootOrThrow(ctx.cwd);
  const r = await resolveReview(ctx, store, root, ref);
  if (!yes) {
    if (!ctx.interactive)
      throw new CliError(`crit: pass --yes to delete review ${shortId(r.id)}`, {
        exitCode: EXIT.usage,
      });
    if (
      !(await ctx.prompter.confirm({
        message: `Delete review ${shortId(r.id)} (${r.scopeLabel})?`,
        initialValue: false,
      }))
    )
      return EXIT.cancelled;
  }
  await store.reviews.delete(r.id);
  ctx.out(`Deleted review ${shortId(r.id)}\n`);
  return EXIT.ok;
}

export async function pruneReviews(
  ctx: CliContext,
  args: { "older-than"?: string; "all-repos"?: boolean; yes?: boolean },
): Promise<number> {
  if (!args["older-than"])
    throw new CliError("crit: pass --older-than, e.g. 90d", { exitCode: EXIT.usage });
  const before = ctx.now() - parseAge(args["older-than"]);
  const store = ctx.openStore();
  let repoId: string | undefined;
  if (!args["all-repos"]) {
    const root = await repoRootOrThrow(ctx.cwd);
    repoId = (await store.repos.getByRoot(root))?.id;
    if (!repoId) {
      ctx.out("Nothing to prune.\n");
      return EXIT.ok;
    }
  }
  const candidates = (
    await listHistory(store.db, {
      ...(repoId ? { repoId } : {}),
      until: before - 1,
      limit: 100_000,
    })
  ).length;
  if (candidates === 0) {
    ctx.out("Nothing to prune.\n");
    return EXIT.ok;
  }
  if (
    !args.yes &&
    ctx.interactive &&
    !(await ctx.prompter.confirm({
      message: `Delete ${plural(candidates, "review")} older than ${args["older-than"]}?`,
      initialValue: false,
    }))
  )
    return EXIT.cancelled;
  if (!args.yes && !ctx.interactive)
    throw new CliError(`crit: pass --yes to delete ${plural(candidates, "review")}`, {
      exitCode: EXIT.usage,
    });
  const deleted = await store.reviews.deleteOlderThan(before, repoId);
  ctx.out(`Deleted ${plural(deleted.length, "review")} older than ${args["older-than"]}\n`);
  return EXIT.ok;
}

const filterArgs = {
  branch: { type: "string", description: "Only this branch" },
  scope: { type: "string", description: "Scope label contains this text" },
  provider: { type: "string", description: "Only this provider" },
  since: { type: "string", description: "Since a date (2026-11-01) or an age (7d)" },
  "all-repos": { type: "boolean", description: "Reviews from every repo" },
  limit: { type: "string", description: "Max rows (default 50)" },
  json: { type: "boolean", description: "Print JSON" },
} as const;

export const historyDef = (ctx: CliContext) =>
  defineCommand({
    meta: {
      name: "history",
      description: "Browse past reviews; --compare <a> <b>; rm <id>; prune --older-than 90d",
    },
    args: {
      ...filterArgs,
      compare: {
        type: "boolean",
        description: "Compare two reviews: crit history --compare <a> <b>",
      },
      list: { type: "boolean", description: "With --compare: list every finding" },
      tui: { type: "boolean", default: true, description: "Open the history screen in a terminal" },
      "older-than": { type: "string", description: "With prune: age, e.g. 90d" },
      yes: { type: "boolean", alias: "y", description: "With rm/prune: do not ask" },
    },
    run: async ({ args }) => {
      const pos = (args._ ?? []).map(String);
      if (pos[0] === "rm") {
        if (!pos[1])
          throw new CliError("crit: crit history rm <review-id>", { exitCode: EXIT.usage });
        process.exitCode = await removeReview(ctx, pos[1], args.yes);
      } else if (pos[0] === "prune") process.exitCode = await pruneReviews(ctx, args as never);
      else
        process.exitCode = await historyCommand(ctx, {
          ...(args as unknown as HistoryArgs),
          _: pos,
        });
    },
  });
