import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { type FindingInput, type ResolvedScope, SEVERITY_ORDER, type Severity } from "@crit/schema";
import { gitRaw } from "../git.ts";
import { lineCount, locateAnchor } from "./anchor.ts";
import { fingerprint } from "./fingerprint.ts";
import { checkPatch } from "./patch.ts";

export const HUNK_SLACK = 3;

export type IntakeResult =
  | {
      accepted: true;
      finding: FindingInput;
      fingerprint: string;
      warnings: string[];
      dropped?: "suppressed" | "below-threshold";
    }
  | { accepted: false; errors: string[] };

export type IntakeOptions = {
  scope: ResolvedScope;
  ruleIds: Set<string>;
  suppressed: Set<string>;
  severityThreshold?: Severity;
  checkPatches?: boolean;
};

export async function readAtRevision(
  scope: ResolvedScope,
  path: string,
): Promise<string | undefined> {
  const spec = scope.spec;
  if (spec.kind === "commit" || spec.kind === "staged") {
    const ref = spec.kind === "commit" ? `${scope.headSha}:${path}` : `:${path}`;
    const gitResult = await gitRaw(scope.root, ["show", ref]);
    return gitResult.exitCode === 0 ? gitResult.stdout : undefined;
  }
  try {
    return readFileSync(join(scope.root, path), "utf8");
  } catch {
    return undefined;
  }
}

function normalizePath(root: string, file: string): string {
  let f = file.trim().replace(/\\/g, "/");
  if (isAbsolute(f)) f = relative(root, f).split(sep).join("/");
  return f.replace(/^(\.\/|a\/|b\/)/, "");
}

export type Intake = {
  opts: IntakeOptions;
  restrictTo(files: string[]): Intake;
  check(input: FindingInput, options?: { allowRetry?: boolean }): Promise<IntakeResult>;
};

export const createIntake = (intakeOptions: IntakeOptions): Intake => {
  const patchFailures = new Map<string, number>();
  const reportable = new Map(
    intakeOptions.scope.files
      .filter((file) => file.status !== "deleted")
      .map((file) => [file.path, file]),
  );

  const restrictTo = (files: string[]): Intake => {
    const scope = {
      ...intakeOptions.scope,
      files: intakeOptions.scope.files.filter((file) => files.includes(file.path)),
    };
    return createIntake({ ...intakeOptions, scope });
  };

  const check = async (
    input: FindingInput,
    opts: { allowRetry?: boolean } = {},
  ): Promise<IntakeResult> => {
    const allowRetry = opts.allowRetry ?? true;
    const errors: string[] = [];
    const warnings: string[] = [];
    const file = normalizePath(intakeOptions.scope.root, input.file);
    const scoped = reportable.get(file);
    if (!scoped) {
      const sample = [...reportable.keys()].slice(0, 8).join(", ");
      return {
        accepted: false,
        errors: [
          `file: ${file} is not in this review's scope (you may report on: ${sample}${reportable.size > 8 ? ", …" : ""})`,
        ],
      };
    }
    const content = await readAtRevision(intakeOptions.scope, file);
    if (content === undefined)
      return { accepted: false, errors: [`file: ${file} could not be read`] };

    const total = lineCount(content);
    let range = input.range;
    if (range.start > total)
      errors.push(`range: line ${range.start} is past the end of ${file} (${total} lines)`);
    const match = locateAnchor(content, input.anchor, range);
    if (!match) {
      errors.push(`anchor: not found in ${file}; copy the code exactly as it appears in the file`);
    } else if (match.range.start > range.end || match.range.end < range.start) {
      warnings.push(
        `range moved from ${range.start}-${range.end} to ${match.range.start}-${match.range.end} to match the anchor`,
      );
      range = match.range;
    } else if (range.end > total) {
      range = { start: range.start, end: Math.max(match.range.end, Math.min(range.end, total)) };
    }
    if (errors.length) return { accepted: false, errors };

    if (scoped.hunks && scoped.status !== "added" && scoped.hunks.length > 0) {
      const onChange = scoped.hunks.some(
        (hunk) =>
          range.start <= hunk.start + Math.max(hunk.lines, 1) - 1 + HUNK_SLACK &&
          range.end >= hunk.start - HUNK_SLACK,
      );
      if (!onChange) {
        const changed = scoped.hunks
          .map((hunk) =>
            hunk.lines <= 1 ? `${hunk.start}` : `${hunk.start}-${hunk.start + hunk.lines - 1}`,
          )
          .join(", ");
        return {
          accepted: false,
          errors: [
            `range: lines ${range.start}-${range.end} are outside the changed lines of ${file} (changed: ${changed}). Report on the changed lines that cause the problem.`,
          ],
        };
      }
    }

    const unknown = input.ruleIds.filter((id) => !intakeOptions.ruleIds.has(id));
    const ruleIds = input.ruleIds.filter((id) => intakeOptions.ruleIds.has(id));
    if (unknown.length) warnings.push(`ruleIds: unknown rule ids dropped: ${unknown.join(", ")}`);

    const normalized: FindingInput = { ...input, file, range, ruleIds };
    const fp = fingerprint(normalized);

    if (input.fix && intakeOptions.checkPatches !== false) {
      const check = await checkPatch(intakeOptions.scope.root, input.fix.patch);
      if (check.ok) normalized.fix = { summary: input.fix.summary, patch: check.patch };
      else {
        const n = (patchFailures.get(fp) ?? 0) + 1;
        patchFailures.set(fp, n);
        if (allowRetry && n === 1) {
          return {
            accepted: false,
            errors: [
              `fix.patch: does not apply (${check.error}). Fix the patch against the current file, or report again without fix.`,
            ],
          };
        }
        delete normalized.fix;
        warnings.push(`fix.patch did not apply (${check.error}); finding kept without a fix`);
      }
    }

    const threshold = intakeOptions.severityThreshold;
    if (
      threshold &&
      SEVERITY_ORDER.indexOf(normalized.severity) > SEVERITY_ORDER.indexOf(threshold)
    ) {
      return {
        accepted: true,
        finding: normalized,
        fingerprint: fp,
        warnings,
        dropped: "below-threshold",
      };
    }
    if (intakeOptions.suppressed.has(fp)) {
      return {
        accepted: true,
        finding: normalized,
        fingerprint: fp,
        warnings,
        dropped: "suppressed",
      };
    }
    return { accepted: true, finding: normalized, fingerprint: fp, warnings };
  };

  return { opts: intakeOptions, restrictTo, check };
};
