import { diffPath, parseUnifiedDiff } from "../diff.ts";
import { gitRaw } from "../git.ts";

export type PatchCheck =
  | { ok: true; patch: string; files: string[] }
  | { ok: false; error: string };

export function normalizePatch(patch: string): string {
  let p = patch.replace(/\r\n/g, "\n");
  p = p.replace(/^```(?:diff|patch)?\n/, "").replace(/\n```\s*$/, "\n");
  const lines = p.split("\n");
  const fixed = lines.map((line) => {
    const match = /^(---|\+\+\+) (?!a\/|b\/|\/dev\/null)(\S.*)$/.exec(line);
    if (!match) return line;
    return `${match[1]} ${match[1] === "---" ? "a" : "b"}/${match[2]}`;
  });
  p = fixed.join("\n");
  if (!p.endsWith("\n")) p += "\n";
  return p;
}

function applyFlags(patch: string): string[] {
  const flags = ["--recount", "--whitespace=nowarn"];
  const hunks = parseUnifiedDiff(patch).flatMap((parsedFile) => parsedFile.hunks);
  if (hunks.some((parsedHunk) => !parsedHunk.body.some((l) => l.startsWith(" "))))
    flags.push("--unidiff-zero");
  return flags;
}

export async function checkPatch(root: string, patch: string): Promise<PatchCheck> {
  const p = normalizePatch(patch);
  const files = parseUnifiedDiff(p);
  if (files.every((parsedFile) => parsedFile.hunks.length === 0)) {
    return { ok: false, error: "not a unified diff (expected ---/+++ headers and @@ hunks)" };
  }
  const gitResult = await gitRaw(root, ["apply", "--check", ...applyFlags(p), "-"], p);
  if (gitResult.exitCode !== 0)
    return {
      ok: false,
      error: gitResult.stderr.trim() || `git apply exited ${gitResult.exitCode}`,
    };
  return { ok: true, patch: p, files: files.map(diffPath) };
}

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
