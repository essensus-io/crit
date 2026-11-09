import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ApplyResult,
  type ApplyTarget,
  applyFixes,
  askAboutFinding,
  diffFromEdit,
  dismissFinding,
  draftAiFix,
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
import { copyToClipboard } from "../../../shared/lib/clipboard.ts";
import { type Editor } from "../../../shared/lib/terminal-editor.ts";
import type { Tok } from "../../../shared/lib/highlight.ts";
import { findingPrompt } from "../lib/finding-prompt.ts";

const MAX_DRAFTS = 3;

export type RuleRef = { id: string; title: string; path: string; section?: string };

export type FindingView = {
  finding: Finding;
  fix?: Fix;
  aiFix?: Fix;
  userFix?: Fix;
  messages: Message[];
};

export type CodeInfo = {
  lines: string[];
  added: Set<number>;
  tokens?: Tok[][] | null;
};

export type SessionState = {
  review: Review;
  code: Map<string, CodeInfo>;
  items: FindingView[];
  rules: Map<string, RuleRef>;
  disabledRules: string[];
  drafting: string[];
  omitted: string[];
  busy?: string;
  notice?: string;
  error?: string;
};

export type SessionDeps = {
  store: SqliteStore;
  root: string;
  reviewId: string;
  fixContext?: FixContext;
  editor: Editor;
  backupRoot: string;
  verifyCommands: string[];
  rebase?: Rebaser;
  recheck?: (file: string) => Promise<string>;
  copy?: (text: string) => string;
  code?: { read: (path: string) => Promise<string>; added: (path: string) => Set<number> };
};

export class ReviewSession {
  state!: SessionState;
  private readonly listeners = new Set<() => void>();
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
    const why = (r: string) =>
      r === "suppressed" ? "marked won't fix before" : "below the severity threshold";
    const omitted = [
      ...(await store.events.list(reviewId, "rejected")).map((e) => {
        const p = e.payload as { title?: string; errors?: string[] };
        return `${p.title ?? "a finding"}: rejected, ${p.errors?.[0] ?? "failed crit's checks"}`;
      }),
      ...(await store.events.list(reviewId, "hidden")).map((e) => {
        const p = e.payload as { title?: string; why?: string };
        return `${p.title ?? "a finding"}: hidden, ${why(p.why ?? "")}`;
      }),
    ];
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
      drafting: [...this.draftingIds],
      omitted,
    };
    for (const l of this.listeners) l();
    return this.state;
  }

  private readonly codeCache = new Map<string, CodeInfo>();
  private readonly draftingIds = new Set<string>();

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
      } catch {}
    }
  }

  item(id: string): FindingView | undefined {
    return this.state.items.find((i) => i.finding.id === id);
  }

  private async run<T>(busy: string, fn: () => Promise<T>): Promise<T | undefined> {
    this.set({ busy, error: undefined, notice: undefined });
    this.codeCache.clear();
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

  draftFix(id: string, instruction?: string) {
    const it = this.item(id);
    if (!it) return;
    if (this.draftingIds.has(id)) return this.notify("Already writing a fix for this one.");
    if (this.draftingIds.size >= MAX_DRAFTS)
      return this.notify(`${MAX_DRAFTS} fixes are being written; wait for one to finish.`);
    let ctx: FixContext;
    try {
      ctx = this.needAi();
    } catch (err) {
      return this.set({ error: (err as Error).message });
    }
    this.draftingIds.add(id);
    this.set({ drafting: [...this.draftingIds], notice: undefined, error: undefined });
    const { finding } = it;
    void draftAiFix(ctx, finding, {
      ...(instruction ? { instruction } : {}),
      ...(it.fix ? { from: it.fix } : {}),
    }).then(
      async () => {
        this.draftingIds.delete(id);
        if (instruction) await this.deps.store.findings.update(id, { selected: false });
        await this.load().catch(() => undefined);
        this.set({ notice: `Fix ready for “${finding.title}”. Space checks it.` });
      },
      async (err: Error) => {
        this.draftingIds.delete(id);
        await this.load().catch(() => undefined);
        this.set({ error: `Could not write a fix for “${finding.title}”: ${err.message}` });
      },
    );
  }

  notify(notice: string | undefined) {
    this.set({ notice, error: undefined });
  }

  async toggle(id: string) {
    const it = this.item(id);
    if (!it) return;
    if (!it.fix && !it.finding.selected) {
      this.set({ notice: "This finding has no fix to apply. Press i to tell the AI the fix." });
      return;
    }
    const selected = !it.finding.selected;
    this.set({
      items: this.state.items.map((v) =>
        v.finding.id === id ? { ...v, finding: { ...v.finding, selected } } : v,
      ),
    });
    await this.deps.store.findings.update(id, { selected });
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

  apply(
    target: ApplyTarget = { kind: "worktree" },
    only?: string[],
  ): Promise<ApplyResult | undefined> {
    return this.run("Applying fixes…", async () => {
      const r = await applyFixes({
        store: this.deps.store,
        reviewId: this.deps.reviewId,
        root: this.deps.root,
        target,
        backupRoot: this.deps.backupRoot,
        ...(only ? { only } : {}),
        ...(this.deps.verifyCommands.length ? { verifyCommands: this.deps.verifyCommands } : {}),
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

  async applyOne(id: string) {
    const it = this.item(id);
    if (!it) return;
    if (!it.fix) return this.notify("This finding has no fix to apply yet.");
    if (it.finding.status !== "open") return this.notify("This one is already dealt with.");
    await this.deps.store.findings.update(id, { selected: true });
    await this.load();
    return this.apply({ kind: "worktree" }, [id]);
  }

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

  ruleRows() {
    return [...this.state.rules.values()].map((ref) => {
      const key = ref.section ? `${ref.path}#${ref.section}` : ref.path;
      return { ref, key, disabled: this.state.disabledRules.includes(key) };
    });
  }

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
