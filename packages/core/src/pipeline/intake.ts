import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { type FindingInput, type ResolvedScope, SEVERITY_ORDER, type Severity } from "@crit/schema";
import { gitRaw } from "../git.ts";
import { lineCount, locateAnchor } from "./anchor.ts";
import { fingerprint } from "./fingerprint.ts";
import { checkPatch } from "./patch.ts";

/** Lines around a hunk that still count as "on the change". */
export const HUNK_SLACK = 3;

export type IntakeResult =
  | {
      accepted: true;
      finding: FindingInput;
      fingerprint: string;
      warnings: string[];
      /** Matched a dismissed fingerprint, or below the severity threshold: acknowledged, not stored. */
      dropped?: "suppressed" | "below-threshold";
    }
  | { accepted: false; errors: string[] };

export type IntakeOptions = {
  scope: ResolvedScope;
  /** Rule ids the agent may cite. */
  ruleIds: Set<string>;
  suppressed: Set<string>;
  severityThreshold?: Severity;
  /** Check patches with git apply (default true). */
  checkPatches?: boolean;
};

/** Read a file at the reviewed revision: the commit for commit scopes, the index for staged, else the working tree. */
export async function readAtRevision(
  scope: ResolvedScope,
  path: string,
): Promise<string | undefined> {
  const spec = scope.spec;
  if (spec.kind === "commit" || spec.kind === "staged") {
    const ref = spec.kind === "commit" ? `${scope.headSha}:${path}` : `:${path}`;
    const r = await gitRaw(scope.root, ["show", ref]);
    return r.exitCode === 0 ? r.stdout : undefined;
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

/**
 * Validates findings from one agent run. Keeps per-run state: a fix whose
 * patch fails is sent back once; the second failure keeps the finding without a fix.
 */
export class Intake {
  private readonly patchFailures = new Map<string, number>();
  private readonly reportable: Map<string, ResolvedScope["files"][number]>;
  readonly opts: IntakeOptions;

  constructor(opts: IntakeOptions) {
    this.opts = opts;
    this.reportable = new Map(
      opts.scope.files.filter((f) => f.status !== "deleted").map((f) => [f.path, f]),
    );
  }

  restrictTo(files: string[]): Intake {
    const scope = {
      ...this.opts.scope,
      files: this.opts.scope.files.filter((f) => files.includes(f.path)),
    };
    return new Intake({ ...this.opts, scope });
  }

  async check(input: FindingInput, opts: { allowRetry?: boolean } = {}): Promise<IntakeResult> {
    const allowRetry = opts.allowRetry ?? true;
    const errors: string[] = [];
    const warnings: string[] = [];
    const file = normalizePath(this.opts.scope.root, input.file);
    const scoped = this.reportable.get(file);
    if (!scoped) {
      const sample = [...this.reportable.keys()].slice(0, 8).join(", ");
      return {
        accepted: false,
        errors: [
          `file: ${file} is not in this review's scope (you may report on: ${sample}${this.reportable.size > 8 ? ", …" : ""})`,
        ],
      };
    }
    const content = await readAtRevision(this.opts.scope, file);
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
        (h) =>
          range.start <= h.start + Math.max(h.lines, 1) - 1 + HUNK_SLACK &&
          range.end >= h.start - HUNK_SLACK,
      );
      if (!onChange) {
        const changed = scoped.hunks
          .map((h) => (h.lines <= 1 ? `${h.start}` : `${h.start}-${h.start + h.lines - 1}`))
          .join(", ");
        return {
          accepted: false,
          errors: [
            `range: lines ${range.start}-${range.end} are outside the changed lines of ${file} (changed: ${changed}). Report on the changed lines that cause the problem.`,
          ],
        };
      }
    }

    const unknown = input.ruleIds.filter((id) => !this.opts.ruleIds.has(id));
    const ruleIds = input.ruleIds.filter((id) => this.opts.ruleIds.has(id));
    if (unknown.length) warnings.push(`ruleIds: unknown rule ids dropped: ${unknown.join(", ")}`);

    const normalized: FindingInput = { ...input, file, range, ruleIds };
    const fp = fingerprint(normalized);

    if (input.fix && this.opts.checkPatches !== false) {
      const check = await checkPatch(this.opts.scope.root, input.fix.patch);
      if (check.ok) normalized.fix = { summary: input.fix.summary, patch: check.patch };
      else {
        const n = (this.patchFailures.get(fp) ?? 0) + 1;
        this.patchFailures.set(fp, n);
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

    const threshold = this.opts.severityThreshold;
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
    if (this.opts.suppressed.has(fp)) {
      return {
        accepted: true,
        finding: normalized,
        fingerprint: fp,
        warnings,
        dropped: "suppressed",
      };
    }
    return { accepted: true, finding: normalized, fingerprint: fp, warnings };
  }
}
