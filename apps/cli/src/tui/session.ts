import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ApplyResult,
  type ApplyTarget,
  applyFixes,
  askAboutFinding,
  diffFromEdit,
  dismissFinding,
  type FixContext,
  getDisabledRules,
  keepAiFix,
  patchedContent,
  type ProposalInput,
  type ProposalOutcome,
  proposeFix,
  type Rebaser,
  restoreFinding,
  saveEditedFix,
  setRuleDisabled,
  useFixAnyway,
} from "@crit/core";
import type { DismissReason, Finding, Fix, Message, Review } from "@crit/schema";
import type { SqliteStore } from "@crit/store";
import { copyToClipboard } from "../clipboard.ts";
import type { Tok } from "./highlight.ts";
import { findingPrompt } from "./prompt.ts";

export type RuleRef = { id: string; title: string; path: string; section?: string };

export type FindingView = {
  finding: Finding;
  /** The active fix (AI or the user's). */
  fix?: Fix;
  aiFix?: Fix;
  /** The latest user fix, if any. */
  userFix?: Fix;
  messages: Message[];
};

/** A file's text and which of its lines the reviewed change added. */
export type CodeInfo = {
  lines: string[];
  added: Set<number>;
  /** Colored pieces per line, filled in when the stream is built. */
  tokens?: Tok[][] | null;
};

export type SessionState = {
  review: Review;
  /** Code of every file that has a finding, for showing findings in place. */
  code: Map<string, CodeInfo>;
  items: FindingView[];
  rules: Map<string, RuleRef>;
  /** Keys (`path#Section`) of rules turned off for this repository. */
  disabledRules: string[];
  busy?: string;
  notice?: string;
  error?: string;
};

/** Opens content in $EDITOR and returns the edited text, or undefined if unchanged/cancelled. */
export type Editor = (content: string, filename: string) => Promise<string | undefined>;

export type SessionDeps = {
  store: SqliteStore;
  root: string;
  reviewId: string;
  /** Provider used to evaluate proposals and answer questions; undefined = offline (no AI actions). */
  fixContext?: FixContext;
  editor: Editor;
  backupRoot: string;
  verifyCommands: string[];
  rebase?: Rebaser;
  /** Re-review one file; returns the id of a temporary review holding the fresh findings. */
  recheck?: (file: string) => Promise<string>;
  /** Put text on the clipboard; returns where it went. */
  copy?: (text: string) => string;
  /** File text at the reviewed revision, and the lines the change added. */
  code?: { read: (path: string) => Promise<string>; added: (path: string) => Set<number> };
};

/**
 * State and actions behind the review screen. Holds no terminal code; the
 * Ink screens render `state` and call these actions.
 */
export class ReviewSession {
  state!: SessionState;
  private readonly listeners = new Set<() => void>();
  /** Hands the terminal to a child process (Ink's suspendTerminal); set by the app. */
  suspend: ((fn: () => Promise<void>) => Promise<void>) | undefined;
  private readonly deps: SessionDeps;

  constructor(deps: SessionDeps) {
    this.deps = deps;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  async load(): Promise<SessionState> {
    const { store, reviewId } = this.deps;
    const review = await store.reviews.get(reviewId);
    if (!review) throw new Error(`crit: review ${reviewId} not found`);
    const findings = await store.findings.listByReview(reviewId);
    const fixes = await store.fixes.listByReview(reviewId);
    const messages = await store.messages.listByReview(reviewId);
    const ruleEvent = (await store.events.list(reviewId, "rules")).at(-1)?.payload as
      | { rules: RuleRef[] }
      | undefined;
    const items = findings.map((finding): FindingView => {
      const own = fixes.filter((f) => f.findingId === finding.id);
      const v: FindingView = {
        finding,
        messages: messages.filter((m) => m.findingId === finding.id),
      };
      const active = own.find((f) => f.active);
      const ai = own.filter((f) => f.author === "ai").at(-1);
      const user = own.filter((f) => f.author === "user").at(-1);
      if (active) v.fix = active;
      if (ai) v.aiFix = ai;
      if (user) v.userFix = user;
      return v;
    });
    await this.loadCode([...new Set(items.map((i) => i.finding.file))]);
    this.state = {
      ...this.state,
      review,
      code: this.codeCache,
      items,
      rules: new Map((ruleEvent?.rules ?? []).map((r) => [r.id, r])),
      disabledRules: await getDisabledRules(this.deps.store, review.repoId),
    };
    for (const l of this.listeners) l();
    return this.state;
  }

  private readonly codeCache = new Map<string, CodeInfo>();

  private async loadCode(files: string[]) {
    const source = this.deps.code;
    if (!source) return;
    for (const file of files) {
      if (this.codeCache.has(file)) continue;
      try {
        const text = await source.read(file);
        this.codeCache.set(file, {
          lines: text.replace(/\n$/, "").split("\n"),
          added: source.added(file),
        });
      } catch {
        // a file that cannot be read is shown without its code
      }
    }
  }

  item(id: string): FindingView | undefined {
    return this.state.items.find((i) => i.finding.id === id);
  }

  /** Wrap a slow action: show `busy`, reload after, surface errors as `error`. */
  private async run<T>(busy: string, fn: () => Promise<T>): Promise<T | undefined> {
    this.set({ busy, error: undefined, notice: undefined });
    this.codeCache.clear(); // an apply or re-check changes the files
    try {
      const r = await fn();
      await this.load();
      this.set({ busy: undefined });
      return r;
    } catch (err) {
      await this.load().catch(() => undefined);
      this.set({ busy: undefined, error: (err as Error).message });
      return undefined;
    }
  }

  private needAi(): FixContext {
    if (!this.deps.fixContext)
      throw new Error("no provider configured for AI actions (crit providers add)");
    return this.deps.fixContext;
  }

  notify(notice: string | undefined) {
    this.set({ notice, error: undefined });
  }

  async toggle(id: string) {
    const it = this.item(id);
    if (!it) return;
    if (!it.fix && !it.finding.selected) {
      this.set({ notice: "This finding has no fix to apply. Press p to propose one." });
      return;
    }
    await this.deps.store.findings.update(id, { selected: !it.finding.selected });
    await this.load();
  }

  dismiss(id: string, reason: DismissReason) {
    return this.run("Dismissing…", () =>
      dismissFinding(this.deps.store, this.item(id)!.finding, reason),
    );
  }

  restore(id: string) {
    return this.run("Restoring…", () => restoreFinding(this.deps.store, this.item(id)!.finding));
  }

  propose(id: string, input: ProposalInput, answer?: string): Promise<ProposalOutcome | undefined> {
    return this.run(
      input.kind === "description" ? "Drafting and checking your fix…" : "Checking your fix…",
      async () => {
        const out = await proposeFix(
          this.needAi(),
          this.item(id)!.finding,
          input,
          answer ? { answer } : {},
        );
        if (out.fix.active) await this.deps.store.findings.update(id, { selected: true });
        return out;
      },
    );
  }

  useAnyway(fixId: string) {
    return this.run("Using your fix…", async () => {
      const fix = await useFixAnyway(this.deps.store, fixId);
      await this.deps.store.findings.update(fix.findingId, { selected: true });
    });
  }

  keepAi(id: string) {
    return this.run("Switching to the AI fix…", () => keepAiFix(this.deps.store, id));
  }

  ask(id: string, question: string) {
    return this.run("Asking the agent…", () =>
      askAboutFinding(this.needAi(), this.item(id)!.finding, question),
    );
  }

  /** Run something that needs the real terminal (an editor): the alternate screen is left and restored. */
  private async withTerminal<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.suspend) return fn();
    let result!: T;
    await this.suspend(async () => {
      result = await fn();
    });
    return result;
  }

  private current(file: string): string {
    return readFileSync(join(this.deps.root, file), "utf8");
  }

  /** Open the patched file in $EDITOR; the edit becomes the user's fix. */
  async editFix(id: string) {
    const it = this.item(id)!;
    const original = this.current(it.finding.file);
    let start = original;
    try {
      if (it.fix) start = patchedContent(original, it.fix.patch);
    } catch {
      start = original;
    }
    const edited = await this.withTerminal(() => this.deps.editor(start, it.finding.file));
    if (edited === undefined || edited === start) {
      this.notify("No changes.");
      return;
    }
    const patch = diffFromEdit(it.finding.file, original, edited);
    if (!patch) {
      this.notify("Your edit matches the current file; nothing to save.");
      return;
    }
    await this.run("Saving your edit…", async () => {
      await saveEditedFix(this.deps.store, this.deps.root, it.finding, patch);
      await this.deps.store.findings.update(id, { selected: true });
    });
  }

  /** Write your own version of the file in $EDITOR and have the AI check it. */
  async proposeFromEditor(id: string): Promise<ProposalOutcome | undefined> {
    const it = this.item(id)!;
    const original = this.current(it.finding.file);
    const edited = await this.withTerminal(() => this.deps.editor(original, it.finding.file));
    const patch =
      edited === undefined ? undefined : diffFromEdit(it.finding.file, original, edited);
    if (!patch) {
      this.notify("No changes; nothing to propose.");
      return undefined;
    }
    return this.propose(id, { kind: "patch", patch });
  }

  apply(target: ApplyTarget = { kind: "worktree" }): Promise<ApplyResult | undefined> {
    return this.run("Applying fixes…", async () => {
      const r = await applyFixes({
        store: this.deps.store,
        reviewId: this.deps.reviewId,
        root: this.deps.root,
        target,
        backupRoot: this.deps.backupRoot,
        ...(this.deps.verifyCommands.length ? { verifyCommands: this.deps.verifyCommands } : {}),
        ...(this.deps.rebase ? { rebase: this.deps.rebase } : {}),
      });
      return r;
    }).then((r) => {
      if (r) {
        const parts = [`Applied ${r.applied.length}`];
        if (r.skipped.length) parts.push(`skipped ${r.skipped.length}`);
        if (r.verify) parts.push(r.verify.passed ? "verify passed" : "verify FAILED");
        this.notify(
          `${parts.join(" · ")}${r.branch ? ` → ${r.branch}` : " · crit undo restores the files"}`,
        );
      }
      return r;
    });
  }

  /** Re-run review for one file and replace this review's open findings on it with the fresh ones. */
  recheck(id: string) {
    const it = this.item(id)!;
    if (!this.deps.recheck)
      return Promise.resolve(this.set({ error: "re-check needs a provider (crit providers add)" }));
    return this.run(`Re-checking ${it.finding.file}…`, () => this.recheckFile(it.finding.file));
  }

  private async recheckFile(file: string) {
    const { store, reviewId, recheck } = this.deps;
    const temp = await recheck!(file);
    for (const f of await store.findings.listByReview(reviewId)) {
      if (f.file === file && f.status === "open")
        await store.findings.update(f.id, { status: "closed", selected: false });
    }
    for (const f of await store.findings.listByReview(temp)) {
      if (f.file === file) await store.findings.reassign(f.id, reviewId);
    }
    await store.reviews.delete(temp);
  }

  /** The finding as a prompt for another agent, on the clipboard. */
  copyPrompt(id: string) {
    const it = this.item(id);
    if (!it) return;
    const refs = it.finding.ruleIds
      .map((r) => this.state.rules.get(r))
      .filter((r): r is RuleRef => r !== undefined);
    const text = findingPrompt(it.finding, it.fix, refs);
    const via = (this.deps.copy ?? copyToClipboard)(text);
    this.notify(`Copied a prompt for “${it.finding.title}” (${text.length} chars) via ${via}.`);
  }

  /** The rules this review used, with whether the user has turned each off. */
  ruleRows() {
    return [...this.state.rules.values()].map((ref) => {
      const key = ref.section ? `${ref.path}#${ref.section}` : ref.path;
      return { ref, key, disabled: this.state.disabledRules.includes(key) };
    });
  }

  /**
   * Turn a rule off or on for this repository. Turning one off re-checks the
   * files whose findings cite it; turning one on applies to the next review
   * or re-check.
   */
  async toggleRule(ruleId: string) {
    const row = this.ruleRows().find((r) => r.ref.id === ruleId);
    if (!row) return;
    const { store, recheck } = this.deps;
    const disable = !row.disabled;
    await setRuleDisabled(store, this.state.review.repoId, row.key, disable);
    if (!disable) {
      await this.load();
      return this.notify(`${row.ref.id} is on again. It applies to the next review or re-check.`);
    }
    const files = [
      ...new Set(
        this.state.items
          .filter((i) => i.finding.status === "open" && i.finding.ruleIds.includes(ruleId))
          .map((i) => i.finding.file),
      ),
    ];
    if (!files.length || !recheck) {
      await this.load();
      return this.notify(
        files.length
          ? `${row.ref.id} is off. Connect a provider to re-check ${files.length} file(s).`
          : `${row.ref.id} is off. No open findings cite it.`,
      );
    }
    await this.run(
      `Re-checking ${files.length} file${files.length === 1 ? "" : "s"} without ${row.ref.id}…`,
      async () => {
        for (const f of files) await this.recheckFile(f);
      },
    );
    this.notify(`${row.ref.id} is off; re-checked ${files.length} file(s).`);
  }
}
