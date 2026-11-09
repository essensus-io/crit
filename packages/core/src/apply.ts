import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Finding, type Fix, newId, shortId, type VerifyResult } from "@crit/schema";
import type { Repositories } from "@crit/store";
import { diffPath, parseUnifiedDiff } from "./diff.ts";
import { git, gitRaw } from "./git.ts";
import { applyPatch, normalizePatch } from "./pipeline/patch.ts";
import { runVerify } from "./verify.ts";

export type ApplyTarget =
  | { kind: "worktree" }
  | { kind: "branch"; squash?: boolean; name?: string };

export type Planned = { finding: Finding; fix: Fix };

export type Overlap = { file: string; a: string; b: string };

function touched(patch: string): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  for (const f of parseUnifiedDiff(normalizePatch(patch))) {
    const path = f.oldPath ?? diffPath(f);
    const ranges = f.hunks.map((h): [number, number] => [
      h.oldStart,
      h.oldStart + Math.max(h.oldLines, 1) - 1,
    ]);
    out.set(path, [...(out.get(path) ?? []), ...ranges]);
  }
  return out;
}

export function findOverlaps(items: Planned[]): Overlap[] {
  const spans = items.map((i) => ({ id: i.finding.id, t: touched(i.fix.patch) }));
  const out: Overlap[] = [];
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      for (const [file, ra] of spans[i]!.t) {
        const rb = spans[j]!.t.get(file);
        if (rb?.some(([s2, e2]) => ra.some(([s1, e1]) => s1 <= e2 + 1 && s2 <= e1 + 1))) {
          out.push({ file, a: spans[i]!.id, b: spans[j]!.id });
        }
      }
    }
  }
  return out;
}

export type Rebaser = (
  item: Planned,
  current: Record<string, string>,
  error: string,
) => Promise<string | undefined>;

export type ApplyResult = {
  applied: Planned[];
  skipped: { finding: Finding; reason: string }[];
  overlaps: Overlap[];
  rebased: string[];
  backupDir?: string;
  branch?: string;
  verify?: VerifyResult;
};

type Manifest = {
  version: 1;
  reviewId: string;
  root: string;
  target: ApplyTarget;
  branch?: string;
  createdAt: number;
  files: { path: string; existed: boolean; after: string | null }[];
  findings: string[];
};

const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export async function plannedFixes(store: Repositories, reviewId: string): Promise<Planned[]> {
  const out: Planned[] = [];
  for (const f of await store.findings.listByReview(reviewId)) {
    if (!f.selected || f.status !== "open" || f.verdict === "rejected") continue;
    const fix = await store.fixes.active(f.id);
    if (fix) out.push({ finding: f, fix });
  }
  return out;
}

async function applyAll(
  root: string,
  items: Planned[],
  rebase: Rebaser | undefined,
  result: ApplyResult,
  afterEach?: (item: Planned) => Promise<void>,
): Promise<Planned[]> {
  const applied: Planned[] = [];
  for (const item of items) {
    let patch = item.fix.patch;
    let r = await applyPatch(root, patch, { check: true });
    if (r.exitCode !== 0 && rebase) {
      const files = [...touched(patch).keys()];
      const current = Object.fromEntries(
        files.map((p) => [p, existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : ""]),
      );
      const next = await rebase(item, current, r.stderr.trim());
      if (next) {
        const again = await applyPatch(root, next, { check: true });
        if (again.exitCode === 0) {
          patch = normalizePatch(next);
          r = again;
          result.rebased.push(item.finding.id);
        }
      }
    }
    if (r.exitCode !== 0) {
      result.skipped.push({
        finding: item.finding,
        reason: `does not apply: ${r.stderr.trim().split("\n")[0]}`,
      });
      continue;
    }
    const done = await applyPatch(root, patch);
    if (done.exitCode !== 0) {
      result.skipped.push({ finding: item.finding, reason: done.stderr.trim() });
      continue;
    }
    const appliedItem = { finding: item.finding, fix: { ...item.fix, patch } };
    applied.push(appliedItem);
    await afterEach?.(appliedItem);
  }
  return applied;
}

export async function applyFixes(opts: {
  store: Repositories;
  reviewId: string;
  root: string;
  target?: ApplyTarget;
  backupRoot: string;
  verifyCommands?: string[];
  rebase?: Rebaser;
  only?: string[];
  now?: () => number;
}): Promise<ApplyResult> {
  const now = opts.now ?? Date.now;
  const target = opts.target ?? { kind: "worktree" };
  let items = await plannedFixes(opts.store, opts.reviewId);
  if (opts.only) items = items.filter((i) => opts.only!.includes(i.finding.id));
  const result: ApplyResult = {
    applied: [],
    skipped: [],
    overlaps: findOverlaps(items),
    rebased: [],
  };
  if (items.length === 0) return result;
  items.sort(
    (a, b) =>
      a.finding.file.localeCompare(b.finding.file) || b.finding.range.start - a.finding.range.start,
  );

  if (target.kind === "branch") {
    const branch = target.name ?? `crit/fixes-${shortId(opts.reviewId)}`;
    if (
      (await gitRaw(opts.root, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]))
        .exitCode === 0
    ) {
      throw new Error(`crit: branch ${branch} already exists`);
    }
    const wt = mkdtempSync(join(tmpdir(), "crit-apply-"));
    await git(opts.root, ["worktree", "add", "-q", "-b", branch, wt, "HEAD"]);
    try {
      const applied = await applyAll(wt, items, opts.rebase, result, async (item) => {
        if (target.squash) return;
        await git(wt, ["add", "-A"]);
        await git(wt, [
          "commit",
          "-q",
          "-m",
          `crit: ${item.finding.title}\n\n${item.fix.summary}\n\nFinding ${item.finding.id} (${item.finding.file}:${item.finding.range.start})`,
        ]);
      });
      if (target.squash && applied.length) {
        await git(wt, ["add", "-A"]);
        await git(wt, [
          "commit",
          "-q",
          "-m",
          `crit: apply ${applied.length} ${applied.length === 1 ? "fix" : "fixes"} from review ${shortId(opts.reviewId)}\n\n${applied.map((a) => `- ${a.finding.title}`).join("\n")}`,
        ]);
      }
      if (opts.verifyCommands?.length && applied.length)
        result.verify = await runVerify(opts.verifyCommands, wt);
      result.applied = applied;
      result.branch = branch;
    } finally {
      await gitRaw(opts.root, ["worktree", "remove", "--force", wt]);
      rmSync(wt, { recursive: true, force: true });
    }
    if (result.applied.length === 0) await gitRaw(opts.root, ["branch", "-D", branch]);
  } else {
    const files = [
      ...new Set(
        items.flatMap((i) => [
          ...touched(i.fix.patch).keys(),
          ...parseUnifiedDiff(normalizePatch(i.fix.patch)).map(diffPath),
        ]),
      ),
    ];
    const backupDir = join(opts.backupRoot, `${shortId(opts.reviewId)}-${now()}`);
    mkdirSync(join(backupDir, "files"), { recursive: true });
    const before = files.map((p) => {
      const abs = join(opts.root, p);
      const existed = existsSync(abs);
      if (existed) {
        const dest = join(backupDir, "files", p);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, readFileSync(abs));
      }
      return { path: p, existed };
    });
    result.applied = await applyAll(opts.root, items, opts.rebase, result);
    writeFileSync(
      join(backupDir, "applied.patch"),
      result.applied.map((a) => a.fix.patch).join(""),
    );
    const manifest: Manifest = {
      version: 1,
      reviewId: opts.reviewId,
      root: opts.root,
      target,
      createdAt: now(),
      findings: result.applied.map((a) => a.finding.id),
      files: before.map((b) => {
        const abs = join(opts.root, b.path);
        return { ...b, after: existsSync(abs) ? hash(readFileSync(abs)) : null };
      }),
    };
    writeFileSync(join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    result.backupDir = backupDir;
    if (opts.verifyCommands?.length && result.applied.length)
      result.verify = await runVerify(opts.verifyCommands, opts.root);
  }

  for (const a of result.applied) {
    await opts.store.findings.update(a.finding.id, { status: "applied" });
    await opts.store.fixes.update(a.fix.id, {
      patch: a.fix.patch,
      ...(result.verify ? { verify: result.verify } : {}),
    });
  }
  if (result.applied.length) {
    await opts.store.events.append(opts.reviewId, "apply", {
      id: newId(now()),
      target,
      ...(result.backupDir ? { backupDir: result.backupDir } : {}),
      ...(result.branch ? { branch: result.branch } : {}),
      findings: result.applied.map((a) => a.finding.id),
    });
  }
  return result;
}

export type UndoResult = {
  restored: string[];
  removed: string[];
  branchDeleted?: string;
  reviewId: string;
};

export async function undoApply(opts: {
  store: Repositories;
  reviewIds: string[];
  root: string;
  force?: boolean;
}): Promise<UndoResult> {
  type ApplyEvent = {
    id: string;
    target: ApplyTarget;
    backupDir?: string;
    branch?: string;
    findings: string[];
  };
  let latest: { reviewId: string; payload: ApplyEvent; createdAt: number } | undefined;
  for (const reviewId of opts.reviewIds) {
    const events = await opts.store.events.list(reviewId);
    const undone = new Set(
      events.filter((e) => e.type === "undo").map((e) => (e.payload as { apply: string }).apply),
    );
    for (const e of events) {
      if (e.type !== "apply") continue;
      const p = e.payload as ApplyEvent;
      if (undone.has(p.id)) continue;
      if (!latest || e.createdAt >= latest.createdAt)
        latest = { reviewId, payload: p, createdAt: e.createdAt };
    }
  }
  if (!latest) throw new Error("crit: nothing to undo");
  const { payload, reviewId } = latest;
  const result: UndoResult = { restored: [], removed: [], reviewId };

  if (payload.branch) {
    const current = (
      await gitRaw(opts.root, ["symbolic-ref", "--short", "-q", "HEAD"])
    ).stdout.trim();
    if (current === payload.branch)
      throw new Error(`crit: ${payload.branch} is checked out; switch to another branch first`);
    await git(opts.root, ["branch", "-D", payload.branch]);
    result.branchDeleted = payload.branch;
  } else {
    const dir = payload.backupDir!;
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
    const changed = manifest.files.filter((f) => {
      const abs = join(opts.root, f.path);
      const now = existsSync(abs) ? hash(readFileSync(abs)) : null;
      return now !== f.after;
    });
    if (changed.length && !opts.force) {
      throw new Error(
        `crit: ${changed.map((f) => f.path).join(", ")} changed after the fixes were applied; pass --force to restore anyway`,
      );
    }
    for (const f of manifest.files) {
      const abs = join(opts.root, f.path);
      if (f.existed) {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, readFileSync(join(dir, "files", f.path)));
        result.restored.push(f.path);
      } else if (existsSync(abs)) {
        unlinkSync(abs);
        result.removed.push(f.path);
      }
    }
  }
  for (const id of payload.findings) {
    const f = await opts.store.findings.get(id);
    if (f?.status === "applied") await opts.store.findings.update(id, { status: "open" });
  }
  await opts.store.events.append(reviewId, "undo", { apply: payload.id });
  return result;
}
