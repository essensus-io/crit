import { diffPath, parseUnifiedDiff } from "../diff.ts";
import { gitRaw } from "../git.ts";

export type PatchCheck =
  | { ok: true; patch: string; files: string[] }
  | { ok: false; error: string };

/** Ensure a patch ends with a newline and uses a/ b/ prefixes (some agents omit them). */
export function normalizePatch(patch: string): string {
  let p = patch.replace(/\r\n/g, "\n");
  // Strip a surrounding ``` fence if the agent wrapped the diff.
  p = p.replace(/^```(?:diff|patch)?\n/, "").replace(/\n```\s*$/, "\n");
  const lines = p.split("\n");
  const fixed = lines.map((l) => {
    const m = /^(---|\+\+\+) (?!a\/|b\/|\/dev\/null)(\S.*)$/.exec(l);
    if (!m) return l;
    return `${m[1]} ${m[1] === "---" ? "a" : "b"}/${m[2]}`;
  });
  p = fixed.join("\n");
  if (!p.endsWith("\n")) p += "\n";
  return p;
}

/**
 * Agents sometimes write hunks without context lines; git only applies those
 * with --unidiff-zero. Positions are still safe: intake checked the anchor.
 */
function applyFlags(patch: string): string[] {
  const flags = ["--recount", "--whitespace=nowarn"];
  const hunks = parseUnifiedDiff(patch).flatMap((f) => f.hunks);
  if (hunks.some((h) => !h.body.some((l) => l.startsWith(" ")))) flags.push("--unidiff-zero");
  return flags;
}

/**
 * `git apply --check` against the working tree. Returns the normalized patch
 * and the files it touches, or git's error.
 */
export async function checkPatch(root: string, patch: string): Promise<PatchCheck> {
  const p = normalizePatch(patch);
  const files = parseUnifiedDiff(p);
  if (files.every((f) => f.hunks.length === 0)) {
    return { ok: false, error: "not a unified diff (expected ---/+++ headers and @@ hunks)" };
  }
  const r = await gitRaw(root, ["apply", "--check", ...applyFlags(p), "-"], p);
  if (r.exitCode !== 0)
    return { ok: false, error: r.stderr.trim() || `git apply exited ${r.exitCode}` };
  return { ok: true, patch: p, files: files.map(diffPath) };
}

/** Apply a patch to the working tree (or `--reverse`). */
export async function applyPatch(
  root: string,
  patch: string,
  opts: { reverse?: boolean; check?: boolean } = {},
) {
  const p = normalizePatch(patch);
  const args = ["apply", ...applyFlags(p)];
  if (opts.reverse) args.push("--reverse");
  if (opts.check) args.push("--check");
  args.push("-");
  return gitRaw(root, args, p);
}
