import type { ProposalOutcome } from "@crit/core";
import { type ReviewEvent, SEVERITY_ORDER, type Severity } from "@crit/schema";
import { Box, useApp, useInput } from "ink";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useScreen } from "./screen.tsx";
import { Picker } from "./widgets.tsx";
import type { Switcher } from "./switcher.ts";
import { useSwitching } from "./useSwitching.tsx";
import { Choice, TextInput } from "./components.tsx";
import { DetailScreen } from "./DetailScreen.tsx";
import { fileTree, type ListFilter, ListScreen, visibleItems } from "./ListScreen.tsx";
import {
  emptyProgress,
  ProgressScreen,
  type ProgressState,
  reduceProgress,
  type RunRecovery,
  type Selection,
} from "./ProgressScreen.tsx";
import { ProposalScreen } from "./ProposalScreen.tsx";
import type { ReviewSession } from "./session.ts";

type Mode =
  | "none"
  | "rules"
  | "search"
  | "dismiss"
  | "propose"
  | "describe"
  | "ask"
  | "reply"
  | "apply";

const SEVERITY_CYCLE: (Severity | undefined)[] = [undefined, ...SEVERITY_ORDER.slice(0, 3)];

/** The interactive review screen: findings list, finding detail, proposal check. */
export function ReviewApp({
  session,
  onExit,
  switcher,
  onConnect,
}: {
  session: ReviewSession;
  onExit?: () => void;
  switcher?: Switcher;
  onConnect?: () => void;
}) {
  const app = useApp();
  useEffect(() => {
    session.suspend = (fn) => app.suspendTerminal(fn);
    return () => {
      session.suspend = undefined;
    };
  }, [session, app]);
  const state = useSyncExternalStore(
    (fn) => session.subscribe(fn),
    () => session.state,
  );
  const { width, height } = useScreen();
  const [screen, setScreen] = useState<"list" | "detail" | "proposal">("list");
  const [filter, setFilter] = useState<ListFilter>({ tab: "findings" });
  const [cursor, setCursor] = useState(0);
  const [fileCursor, setFileCursor] = useState(0);
  const [focus, setFocus] = useState<"files" | "findings">("findings");
  const [mode, setMode] = useState<Mode>("none");
  const [fixTab, setFixTab] = useState<"ai" | "user">("ai");
  const [outcome, setOutcome] = useState<ProposalOutcome | undefined>();
  const [lastInput, setLastInput] = useState<
    { kind: "patch"; patch: string } | { kind: "description"; text: string } | undefined
  >();

  const items = useMemo(() => visibleItems(state, filter), [state, filter]);
  const current = items[Math.min(cursor, Math.max(0, items.length - 1))];
  const busy = Boolean(state.busy);
  const [, bump] = useState(0);
  const { overlay, modal } = useSwitching({
    switcher,
    active: mode === "none" && !busy,
    onNotice: (m) => session.notify(m),
    ...(onConnect ? { onConnect } : {}),
    onChange: () => bump((n) => n + 1),
  });

  useEffect(() => {
    if (cursor >= items.length && items.length > 0) setCursor(items.length - 1);
  }, [items.length, cursor]);

  const quit = () => {
    onExit?.();
    app.exit();
  };
  const openDetail = () => {
    if (!current) return;
    setFixTab(current.fix?.author === "user" ? "user" : "ai");
    setScreen("detail");
  };
  const showOutcome = (o: ProposalOutcome | undefined) => {
    if (!o) return;
    setOutcome(o);
    setScreen("proposal");
  };

  useInput(
    (input, key) => {
      if (busy) return;
      if (screen === "list") {
        if (input === "q") return quit();
        if (key.tab) {
          setFilter((f) => ({ ...f, tab: f.tab === "findings" ? "filtered" : "findings" }));
          setCursor(0);
          return;
        }
        if (key.leftArrow || input === "h") return setFocus("files");
        if (key.rightArrow || input === "l") return setFocus("findings");
        if (focus === "files") {
          const tree = fileTree(state);
          if (input === "j" || key.downArrow)
            return setFileCursor((c) => Math.min(c + 1, tree.length - 1));
          if (input === "k" || key.upArrow) return setFileCursor((c) => Math.max(c - 1, 0));
          if (key.return || input === " ") {
            const row = tree[fileCursor];
            setFilter((f) => {
              const { file: _f, ...rest } = f;
              return row?.file ? { ...rest, file: row.file } : rest;
            });
            setCursor(0);
            setFocus("findings");
          }
          return;
        }
        if (input === "j" || key.downArrow)
          return setCursor((c) => Math.min(c + 1, Math.max(0, items.length - 1)));
        if (input === "k" || key.upArrow) return setCursor((c) => Math.max(c - 1, 0));
        if (input === "g") return setCursor(0);
        if (input === "G") return setCursor(Math.max(0, items.length - 1));
        if (input === "/") return setMode("search");
        if (input === "s") {
          setFilter((f) => {
            const next =
              SEVERITY_CYCLE[(SEVERITY_CYCLE.indexOf(f.severity) + 1) % SEVERITY_CYCLE.length];
            const { severity: _s, ...rest } = f;
            return next ? { ...rest, severity: next } : rest;
          });
          return;
        }
        if (input === "a") return setMode("apply");
        if (input === "R") return setMode("rules");
        if (input === "y" && current) return void session.copyPrompt(current.finding.id);
        if (!current) return;
        if (key.return) return openDetail();
        if (input === " ") return void session.toggle(current.finding.id);
        if (input === "d")
          return current.finding.status === "dismissed"
            ? void session.restore(current.finding.id)
            : setMode("dismiss");
        if (input === "p") return setMode("propose");
        return;
      }
      if (screen === "detail" && current) {
        if (key.escape || input === "q") return setScreen("list");
        if (input === " ") return void session.toggle(current.finding.id);
        if (input === "n") return setCursor((c) => Math.min(c + 1, items.length - 1));
        if (input === "N") return setCursor((c) => Math.max(c - 1, 0));
        if (key.tab || key.leftArrow || key.rightArrow)
          return setFixTab((t) => (t === "ai" ? "user" : "ai"));
        if (input === "e") return void session.editFix(current.finding.id);
        if (input === "p") return setMode("propose");
        if (input === "?") return setMode("ask");
        if (input === "d")
          return current.finding.status === "dismissed"
            ? void session.restore(current.finding.id)
            : setMode("dismiss");
        if (input === "r") return void session.recheck(current.finding.id);
        if (input === "y") return void session.copyPrompt(current.finding.id);
        if (input === "R") return setMode("rules");
        if (input === "u" && current.userFix && !current.userFix.active)
          return void session.useAnyway(current.userFix.id);
        if (input === "k" && current.aiFix && !current.aiFix.active)
          return void session.keepAi(current.finding.id);
        return;
      }
      if (screen === "proposal" && outcome && current) {
        if (key.escape) return setScreen("detail");
        if (key.return && outcome.evaluation.verdict === "concerns" && !outcome.finalRound)
          return setMode("reply");
        if (input === "u" && outcome.evaluation.verdict !== "accepted") {
          void session.useAnyway(outcome.fix.id).then(() => setScreen("detail"));
          return;
        }
        if (input === "k") {
          void session.keepAi(current.finding.id).then(() => setScreen("detail"));
          return;
        }
      }
    },
    { isActive: mode === "none" && !modal },
  );

  const done = () => setMode("none");
  let prompt: React.ReactNode = null;
  if (mode === "search")
    prompt = (
      <TextInput
        label="/"
        initial={filter.search ?? ""}
        onCancel={done}
        onSubmit={(v) => {
          setFilter((f) => {
            const { search: _s, ...rest } = f;
            return v ? { ...rest, search: v } : rest;
          });
          setCursor(0);
          done();
        }}
      />
    );
  if (mode === "dismiss" && current)
    prompt = (
      <Choice
        label="Dismiss:"
        options={[
          ["f", "false positive"],
          ["w", "won't fix"],
          ["l", "later"],
        ]}
        onCancel={done}
        onPick={(k) => {
          done();
          void session.dismiss(
            current.finding.id,
            k === "f" ? "false-positive" : k === "w" ? "wont-fix" : "later",
          );
        }}
      />
    );
  if (mode === "propose" && current)
    prompt = (
      <Choice
        label="Propose a fix:"
        options={[
          ["e", "write it in $EDITOR"],
          ["w", "describe it in words"],
        ]}
        onCancel={done}
        onPick={(k) => {
          if (k === "w") return setMode("describe");
          done();
          void session.proposeFromEditor(current.finding.id).then((o) => {
            if (o && lastInput === undefined) setLastInput({ kind: "patch", patch: o.fix.patch });
            showOutcome(o);
          });
        }}
      />
    );
  if (mode === "describe" && current)
    prompt = (
      <TextInput
        label="Describe your fix ›"
        onCancel={done}
        onSubmit={(text) => {
          done();
          if (!text.trim()) return;
          void session.propose(current.finding.id, { kind: "description", text }).then((o) => {
            if (o) setLastInput({ kind: "patch", patch: o.fix.patch });
            showOutcome(o);
          });
        }}
      />
    );
  if (mode === "ask" && current)
    prompt = (
      <TextInput
        label="Ask ›"
        onCancel={done}
        onSubmit={(q) => {
          done();
          if (q.trim()) void session.ask(current.finding.id, q.trim());
        }}
      />
    );
  if (mode === "reply" && current && outcome)
    prompt = (
      <TextInput
        label="you ›"
        onCancel={done}
        onSubmit={(answer) => {
          done();
          if (!answer.trim()) return;
          void session
            .propose(
              current.finding.id,
              lastInput ?? { kind: "patch", patch: outcome.fix.patch },
              answer.trim(),
            )
            .then(showOutcome);
        }}
      />
    );
  if (mode === "apply") {
    const n = state.items.filter(
      (v) => v.finding.selected && v.finding.status === "open" && v.fix,
    ).length;
    prompt = (
      <Choice
        label={`Apply ${n} checked fix${n === 1 ? "" : "es"}:`}
        options={[
          ["y", "to the working tree"],
          ["b", "to a new branch"],
        ]}
        onCancel={done}
        onPick={(k) => {
          done();
          void session.apply(k === "b" ? { kind: "branch" } : { kind: "worktree" });
        }}
      />
    );
  }

  if (mode === "rules") {
    const rows = session.ruleRows();
    return (
      <Picker
        title="rules in this review · enter toggles"
        options={rows.map((r) => ({
          value: r.ref.id,
          label: `${r.disabled ? "[ ]" : "[x]"} ${r.ref.id}  ${r.ref.title}`,
          hint: r.ref.path,
        }))}
        width={width}
        height={height}
        note="off = skipped from now on; its files are re-checked"
        onPick={(id) => {
          done();
          void session.toggleRule(id);
        }}
        onCancel={done}
      />
    );
  }
  if (overlay) return overlay;
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {screen === "list" || !current ? (
        <ListScreen
          state={state}
          filter={filter}
          cursor={cursor}
          fileCursor={fileCursor}
          focus={focus}
          width={width}
          height={height}
          prompt={prompt}
          {...(switcher ? { choice: switcher.current() } : {})}
        />
      ) : screen === "detail" ? (
        <DetailScreen
          state={state}
          item={current}
          fixTab={fixTab}
          width={width}
          height={height}
          prompt={prompt}
          position={`${Math.min(cursor, items.length - 1) + 1}/${items.length}`}
          {...(switcher ? { choice: switcher.current() } : {})}
        />
      ) : (
        <ProposalScreen
          state={state}
          outcome={outcome!}
          width={width}
          height={height}
          input={prompt}
        />
      )}
    </Box>
  );
}

/**
 * While a review runs: the progress screen, then the review screen. `enter`
 * opens the findings found so far; `q` stops the review.
 */
export function RunApp(props: {
  subscribe: (fn: (e: ReviewEvent) => void) => () => void;
  makeSession: (reviewId: string) => Promise<ReviewSession>;
  onStop: () => void;
  onRecover?: (action: RunRecovery) => void;
  onExit?: () => void;
  switcher?: Switcher;
}) {
  const app = useApp();
  const { width, height } = useScreen();
  const [progress, setProgress] = useState<ProgressState>(emptyProgress);
  const [reviewId, setReviewId] = useState<string>();
  const [session, setSession] = useState<ReviewSession>();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [, bump] = useState(0);
  const initial = useRef(props.switcher?.current());

  useEffect(
    () =>
      props.subscribe((e) => {
        setProgress((p) => reduceProgress(p, e));
        if (e.type === "review-started") setReviewId(e.reviewId);
        if (e.type === "finding" || e.type === "verified" || e.type === "review-done")
          void session?.load();
      }),
    [props, session],
  );
  useEffect(() => {
    if (
      progress.done &&
      !progress.failed &&
      !progress.rateLimited &&
      !progress.partial &&
      ![...progress.shards.values()].some((s) => s.status === "failed")
    )
      setOpen(true);
  }, [progress]);
  useEffect(() => {
    if (open && reviewId && !session) void props.makeSession(reviewId).then(setSession);
  }, [open, reviewId, session, props]);

  // What the user picked on this screen, as the difference from what the run started with.
  const now = props.switcher?.current();
  const was = initial.current;
  const selection: Selection = {};
  if (now && was) {
    if (now.provider !== was.provider) selection.provider = now.provider;
    if (now.model !== was.model) selection.model = now.model;
    if (now.effort !== was.effort) selection.effort = now.effort;
    if (now.depth !== was.depth) selection.depth = now.depth;
  }
  const connect = () => {
    props.onRecover?.({ kind: "provider" });
    app.exit();
  };
  const { overlay, modal } = useSwitching({
    switcher: props.switcher,
    active: !session,
    onNotice: setNotice,
    ...(props.onRecover ? { onConnect: connect } : {}),
    onChange: () => bump((n) => n + 1),
  });

  useInput(
    (input, key) => {
      if (input === "r" && progress.done && props.onRecover) {
        props.onRecover({ kind: "retry", ...selection });
        app.exit();
        return;
      }
      if (input === "b" && progress.budget && props.onRecover) {
        props.onRecover({ kind: "budget", maxShards: progress.budget.required });
        app.exit();
        return;
      }
      if (input === "q" || (key.ctrl && input === "c")) {
        if (progress.done) {
          props.onExit?.();
          app.exit();
        } else props.onStop();
        return;
      }
      if (key.return && reviewId) setOpen(true);
    },
    { isActive: !session && !modal },
  );

  if (session)
    return (
      <ReviewApp
        session={session}
        {...(props.onExit ? { onExit: props.onExit } : {})}
        {...(props.switcher ? { switcher: props.switcher } : {})}
      />
    );
  if (overlay) return overlay;
  return (
    <ProgressScreen
      progress={progress}
      width={width}
      height={height}
      selection={selection}
      {...(was ? { depth: was.depth, effort: was.effort } : {})}
      {...(notice ? { notice } : {})}
    />
  );
}
