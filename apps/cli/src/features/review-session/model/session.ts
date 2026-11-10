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
  type GhRunner,
  keepAiFix,
  patchedContent,
  type ProposalInput,
  type ProposalOutcome,
  proposeFix,
  publishPrReview,
  type Rebaser,
  restoreFinding,
  saveEditedFix,
  setRuleDisabled,
  useFixAnyway,
} from "@crit/core";
import type { DismissReason, Finding, Fix, Message, Review } from "@crit/schema";
import type { SqliteStore } from "@crit/store";
import { copyToClipboard } from "@/shared/lib/clipboard.ts";
import { type Editor } from "@/shared/lib/terminal-editor.ts";
import type { Tok } from "@/shared/lib/highlight.ts";
import { describePrPost } from "@/features/review-session/lib/describe-pr-post.ts";
import { findingPrompt } from "@/features/review-session/lib/finding-prompt.ts";

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
  gh: GhRunner;
  verifyCommands: string[];
  rebase?: Rebaser;
  recheck?: (file: string) => Promise<string>;
  copy?: (text: string) => string;
  code?: { read: (path: string) => Promise<string>; added: (path: string) => Set<number> };
};

export const createReviewSession = (deps: SessionDeps) => {
  let state!: SessionState;
  let suspend: ((fn: () => Promise<void>) => Promise<void>) | undefined;
  const listeners = new Set<() => void>();
  const codeCache = new Map<string, CodeInfo>();
  const draftingIds = new Set<string>();

  const subscribe = (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  const set = (patch: Partial<SessionState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const load = async (): Promise<SessionState> => {
    const { store, reviewId } = deps;
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
      const own = fixes.filter((fix) => fix.findingId === finding.id);
      const findingView: FindingView = {
        finding,
        messages: messages.filter((message) => message.findingId === finding.id),
      };
      const active = own.find((f) => f.active);
      const ai = own.filter((f) => f.author === "ai").at(-1);
      const user = own.filter((f) => f.author === "user").at(-1);
      if (active) findingView.fix = active;
      if (ai) findingView.aiFix = ai;
      if (user) findingView.userFix = user;
      return findingView;
    });
    await loadCode([...new Set(items.map((i) => i.finding.file))]);
    state = {
      ...state,
      review,
      code: codeCache,
      items,
      rules: new Map((ruleEvent?.rules ?? []).map((ruleRef) => [ruleRef.id, ruleRef])),
      disabledRules: await getDisabledRules(deps.store, review.repoId),
      drafting: [...draftingIds],
      omitted,
    };
    for (const listener of listeners) listener();
    return state;
  };

  const loadCode = async (files: string[]) => {
    const source = deps.code;
    if (!source) return;
    for (const file of files) {
      if (codeCache.has(file)) continue;
      try {
        const text = await source.read(file);
        codeCache.set(file, {
          lines: text.replace(/\n$/, "").split("\n"),
          added: source.added(file),
        });
      } catch {}
    }
  };

  const item = (id: string): FindingView | undefined => {
    return state.items.find((i) => i.finding.id === id);
  };

  const run = async <T>(busy: string, fn: () => Promise<T>): Promise<T | undefined> => {
    set({ busy, error: undefined, notice: undefined });
    codeCache.clear();
    try {
      const result = await fn();
      await load();
      set({ busy: undefined });
      return result;
    } catch (err) {
      await load().catch(() => undefined);
      set({ busy: undefined, error: (err as Error).message });
      return undefined;
    }
  };

  const needAi = (): FixContext => {
    if (!deps.fixContext)
      throw new Error("no provider configured for AI actions (crit providers add)");
    return deps.fixContext;
  };

  const draftFix = (id: string, instruction?: string) => {
    const it = item(id);
    if (!it) return;
    if (draftingIds.has(id)) return notify("Already writing a fix for this one.");
    if (draftingIds.size >= MAX_DRAFTS)
      return notify(`${MAX_DRAFTS} fixes are being written; wait for one to finish.`);
    let ctx: FixContext;
    try {
      ctx = needAi();
    } catch (err) {
      return set({ error: (err as Error).message });
    }
    draftingIds.add(id);
    set({ drafting: [...draftingIds], notice: undefined, error: undefined });
    const { finding } = it;
    void draftAiFix(ctx, finding, {
      ...(instruction ? { instruction } : {}),
      ...(it.fix ? { from: it.fix } : {}),
    }).then(
      async () => {
        draftingIds.delete(id);
        if (instruction) await deps.store.findings.update(id, { selected: false });
        await load().catch(() => undefined);
        set({ notice: `Fix ready for “${finding.title}”. Space checks it.` });
      },
      async (err: Error) => {
        draftingIds.delete(id);
        await load().catch(() => undefined);
        set({ error: `Could not write a fix for “${finding.title}”: ${err.message}` });
      },
    );
  };

  const notify = (notice: string | undefined) => {
    set({ notice, error: undefined });
  };

  const toggle = async (id: string) => {
    const it = item(id);
    if (!it) return;
    if (!it.fix && !it.finding.selected) {
      set({ notice: "This finding has no fix to apply. Press i to tell the AI the fix." });
      return;
    }
    const selected = !it.finding.selected;
    set({
      items: state.items.map((findingView) =>
        findingView.finding.id === id
          ? { ...findingView, finding: { ...findingView.finding, selected } }
          : findingView,
      ),
    });
    await deps.store.findings.update(id, { selected });
  };

  const postFindingToPr = async (id: string) => {
    const it = item(id);
    if (!it) return;
    if (it.finding.status !== "open") return notify("This one is already dealt with.");
    const result = await run("Posting to the pull request…", () =>
      publishPrReview({
        gh: deps.gh,
        store: deps.store,
        root: deps.root,
        reviewId: deps.reviewId,
        findingIds: [id],
      }),
    );
    if (result) notify(describePrPost(result));
  };

  const dismiss = (id: string, reason: DismissReason) => {
    return run("Dismissing…", () => dismissFinding(deps.store, item(id)!.finding, reason));
  };

  const restore = (id: string) => {
    return run("Restoring…", () => restoreFinding(deps.store, item(id)!.finding));
  };

  const propose = (
    id: string,
    input: ProposalInput,
    answer?: string,
  ): Promise<ProposalOutcome | undefined> => {
    return run(
      input.kind === "description" ? "Drafting and checking your fix…" : "Checking your fix…",
      async () => {
        const out = await proposeFix(needAi(), item(id)!.finding, input, answer ? { answer } : {});
        if (out.fix.active) await deps.store.findings.update(id, { selected: true });
        return out;
      },
    );
  };

  const useAnyway = (fixId: string) => {
    return run("Using your fix…", async () => {
      const fix = await useFixAnyway(deps.store, fixId);
      await deps.store.findings.update(fix.findingId, { selected: true });
    });
  };

  const keepAi = (id: string) => {
    return run("Switching to the AI fix…", () => keepAiFix(deps.store, id));
  };

  const ask = (id: string, question: string) => {
    return run("Asking the agent…", () => askAboutFinding(needAi(), item(id)!.finding, question));
  };

  const withTerminal = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (!suspend) return fn();
    let result!: T;
    await suspend(async () => {
      result = await fn();
    });
    return result;
  };

  const current = (file: string): string => {
    return readFileSync(join(deps.root, file), "utf8");
  };

  const editFix = async (id: string) => {
    const findingView = item(id)!;
    const original = current(findingView.finding.file);
    let start = original;
    try {
      if (findingView.fix) start = patchedContent(original, findingView.fix.patch);
    } catch {
      start = original;
    }
    const edited = await withTerminal(() => deps.editor(start, findingView.finding.file));
    if (edited === undefined || edited === start) {
      notify("No changes.");
      return;
    }
    const patch = diffFromEdit(findingView.finding.file, original, edited);
    if (!patch) {
      notify("Your edit matches the current file; nothing to save.");
      return;
    }
    await run("Saving your edit…", async () => {
      await saveEditedFix(deps.store, deps.root, findingView.finding, patch);
      await deps.store.findings.update(id, { selected: true });
    });
  };

  const proposeFromEditor = async (id: string): Promise<ProposalOutcome | undefined> => {
    const findingView = item(id)!;
    const original = current(findingView.finding.file);
    const edited = await withTerminal(() => deps.editor(original, findingView.finding.file));
    const patch =
      edited === undefined ? undefined : diffFromEdit(findingView.finding.file, original, edited);
    if (!patch) {
      notify("No changes; nothing to propose.");
      return undefined;
    }
    return propose(id, { kind: "patch", patch });
  };

  const apply = (
    target: ApplyTarget = { kind: "worktree" },
    only?: string[],
  ): Promise<ApplyResult | undefined> => {
    return run("Applying fixes…", async () => {
      const applyResult = await applyFixes({
        store: deps.store,
        reviewId: deps.reviewId,
        root: deps.root,
        target,
        backupRoot: deps.backupRoot,
        ...(only ? { only } : {}),
        ...(deps.verifyCommands.length ? { verifyCommands: deps.verifyCommands } : {}),
      });
      return applyResult;
    }).then((r) => {
      if (r) {
        const parts = [`Applied ${r.applied.length}`];
        if (r.skipped.length) parts.push(`skipped ${r.skipped.length}`);
        if (r.verify) parts.push(r.verify.passed ? "verify passed" : "verify FAILED");
        notify(
          `${parts.join(" · ")}${r.branch ? ` → ${r.branch}` : " · crit undo restores the files"}`,
        );
      }
      return r;
    });
  };

  const applyOne = async (id: string) => {
    const it = item(id);
    if (!it) return;
    if (!it.fix) return notify("This finding has no fix to apply yet.");
    if (it.finding.status !== "open") return notify("This one is already dealt with.");
    await deps.store.findings.update(id, { selected: true });
    await load();
    return apply({ kind: "worktree" }, [id]);
  };

  const recheck = (id: string) => {
    const findingView = item(id)!;
    if (!deps.recheck)
      return Promise.resolve(set({ error: "re-check needs a provider (crit providers add)" }));
    return run(`Re-checking ${findingView.finding.file}…`, () =>
      recheckFile(findingView.finding.file),
    );
  };

  const recheckFile = async (file: string) => {
    const { store, reviewId, recheck } = deps;
    const temp = await recheck!(file);
    for (const f of await store.findings.listByReview(reviewId)) {
      if (f.file === file && f.status === "open")
        await store.findings.update(f.id, { status: "closed", selected: false });
    }
    for (const f of await store.findings.listByReview(temp)) {
      if (f.file === file) await store.findings.reassign(f.id, reviewId);
    }
    await store.reviews.delete(temp);
  };

  const copyPrompt = (id: string) => {
    const it = item(id);
    if (!it) return;
    const refs = it.finding.ruleIds
      .map((ruleId) => state.rules.get(ruleId))
      .filter((r): r is RuleRef => r !== undefined);
    const text = findingPrompt(it.finding, it.fix, refs);
    const via = (deps.copy ?? copyToClipboard)(text);
    notify(`Copied a prompt for “${it.finding.title}” (${text.length} chars) via ${via}.`);
  };

  const ruleRows = () => {
    return [...state.rules.values()].map((ref) => {
      const key = ref.section ? `${ref.path}#${ref.section}` : ref.path;
      return { ref, key, disabled: state.disabledRules.includes(key) };
    });
  };

  const toggleRule = async (ruleId: string) => {
    const row = ruleRows().find((r) => r.ref.id === ruleId);
    if (!row) return;
    const { store, recheck } = deps;
    const disable = !row.disabled;
    await setRuleDisabled(store, state.review.repoId, row.key, disable);
    if (!disable) {
      await load();
      return notify(`${row.ref.id} is on again. It applies to the next review or re-check.`);
    }
    const files = [
      ...new Set(
        state.items
          .filter((i) => i.finding.status === "open" && i.finding.ruleIds.includes(ruleId))
          .map((i) => i.finding.file),
      ),
    ];
    if (!files.length || !recheck) {
      await load();
      return notify(
        files.length
          ? `${row.ref.id} is off. Connect a provider to re-check ${files.length} file(s).`
          : `${row.ref.id} is off. No open findings cite it.`,
      );
    }
    await run(
      `Re-checking ${files.length} file${files.length === 1 ? "" : "s"} without ${row.ref.id}…`,
      async () => {
        for (const file of files) await recheckFile(file);
      },
    );
    notify(`${row.ref.id} is off; re-checked ${files.length} file(s).`);
  };

  return {
    get state() {
      return state;
    },
    get suspend() {
      return suspend;
    },
    set suspend(value) {
      suspend = value;
    },
    subscribe,
    load,
    item,
    draftFix,
    notify,
    toggle,
    postFindingToPr,
    dismiss,
    restore,
    propose,
    useAnyway,
    keepAi,
    ask,
    editFix,
    proposeFromEditor,
    apply,
    applyOne,
    recheck,
    copyPrompt,
    ruleRows,
    toggleRule,
  };
};

export type ReviewSession = ReturnType<typeof createReviewSession>;
