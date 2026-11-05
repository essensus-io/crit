import type { ProposalOutcome } from "@crit/core";
import type { ReviewEvent } from "@crit/schema";
import { Box, useApp, useInput } from "ink";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Choice, TextInput } from "./components.tsx";
import { fileTree, parseQuery, triage, visibleItems } from "./filter.ts";
import { HelpOverlay } from "./HelpOverlay.tsx";
import {
  emptyProgress,
  ProgressScreen,
  type ProgressState,
  reduceProgress,
  type RunRecovery,
  type Selection,
} from "./ProgressScreen.tsx";
import { ProposalScreen } from "./ProposalScreen.tsx";
import { useScreen } from "./screen.tsx";
import type { ReviewSession } from "./session.ts";
import { StreamScreen } from "./StreamScreen.tsx";
import { describeChoice, type Switcher } from "./switcher.ts";
import { useSwitching } from "./useSwitching.tsx";
import { Menu, type MenuItem, Picker } from "./widgets.tsx";

type Mode =
  | "none"
  | "help"
  | "actions"
  | "options"
  | "rules"
  | "search"
  | "dismiss"
  | "propose"
  | "describe"
  | "ask"
  | "reply"
  | "apply";

/**
 * The interactive review screen: one stream of code with a card under every
 * finding. a / d triage, enter expands, `.` and `o` open the menus.
 */
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
  const [screen, setScreen] = useState<"stream" | "proposal">("stream");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [fileCursor, setFileCursor] = useState(0);
  const [focus, setFocus] = useState<"files" | "stream">("stream");
  const [mode, setMode] = useState<Mode>("none");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [fixTab, setFixTab] = useState<"ai" | "user">("ai");
  const [outcome, setOutcome] = useState<ProposalOutcome | undefined>();
  const [lastInput, setLastInput] = useState<
    { kind: "patch"; patch: string } | { kind: "description"; text: string } | undefined
  >();

  const filter = useMemo(() => parseQuery(query), [query]);
  const items = useMemo(() => visibleItems(state, filter), [state, filter]);
  const current = items[Math.min(cursor, Math.max(0, items.length - 1))];
  const busy = Boolean(state.busy);
  const [, bump] = useState(0);
  const switching = useSwitching({
    switcher,
    active: mode === "none" && !busy,
    hotkeys: false,
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
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        next.add(id);
        setFixTab(current?.fix?.author === "user" ? "user" : "ai");
      }
      return next;
    });
  const showOutcome = (o: ProposalOutcome | undefined) => {
    if (!o) return;
    setOutcome(o);
    setScreen("proposal");
  };
  const move = (to: number) => setCursor(Math.max(0, Math.min(items.length - 1, to)));
  const idle = mode === "none" && !switching.modal && !busy;

  useInput(
    (input, key) => {
      if (busy) return;
      // A message stays until the next key, then gives the line back to progress.
      if (state.notice || state.error) session.notify(undefined);
      if (screen === "proposal" && outcome && current) {
        if (key.escape || input === "q") return setScreen("stream");
        if (key.return && outcome.evaluation.verdict === "concerns" && !outcome.finalRound)
          return setMode("reply");
        if (input === "u" && outcome.evaluation.verdict !== "accepted") {
          void session.useAnyway(outcome.fix.id).then(() => setScreen("stream"));
          return;
        }
        if (input === "k") {
          void session.keepAi(current.finding.id).then(() => setScreen("stream"));
          return;
        }
        return;
      }
      if (input === "q") return quit();
      if (input === "?") return setMode("help");
      if (input === "/") return setMode("search");
      if (input === "o") return setMode("options");
      if (key.escape) {
        if (current && expanded.has(current.finding.id)) return toggleExpanded(current.finding.id);
        if (query) {
          setQuery("");
          return setCursor(0);
        }
        return;
      }
      if (input === "h" || input === "l") return setFocus(input === "h" ? "files" : "stream");
      if (focus === "files") {
        const tree = fileTree(state);
        if (input === "j" || key.downArrow)
          return setFileCursor((c) => Math.min(c + 1, tree.length - 1));
        if (input === "k" || key.upArrow) return setFileCursor((c) => Math.max(c - 1, 0));
        if (key.return) {
          const file = tree[fileCursor]?.file;
          const at = file ? items.findIndex((i) => i.finding.file === file) : -1;
          if (at >= 0) move(at);
          setFocus("stream");
        }
        return;
      }
      if (input === "j" || input === "n") return move(cursor + 1);
      if (input === "k" || input === "N") return move(cursor - 1);
      if (input === "g") return move(0);
      if (input === "G") return move(items.length - 1);
      if (input === "A") return setMode("apply");
      if (!current) return;
      const id = current.finding.id;
      if (key.return) return toggleExpanded(id);
      if (key.tab && expanded.has(id)) return setFixTab((t) => (t === "ai" ? "user" : "ai"));
      if (input === "y") return void session.copyPrompt(id);
      if (input === ".") return setMode("actions");
      if (input === "a") {
        if (triage(current) === "dismissed") return void session.restore(id);
        if (!current.fix && !current.finding.selected) {
          session.notify("There is no fix to accept yet. Describe or write one:");
          return setMode("propose");
        }
        return void session.toggle(id);
      }
      if (input === "d")
        return triage(current) === "dismissed" ? void session.restore(id) : setMode("dismiss");
    },
    { isActive: mode === "none" && !switching.modal },
  );

  const done = () => setMode("none");
  let prompt: React.ReactNode = null;
  if (mode === "search")
    prompt = (
      <TextInput
        label="/"
        initial={query}
        onCancel={done}
        onSubmit={(v) => {
          setQuery(v.trim());
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
          if (q.trim()) {
            setExpanded((prev) => new Set(prev).add(current.finding.id));
            void session.ask(current.finding.id, q.trim());
          }
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
        label={n === 0 ? "Nothing accepted yet." : `Apply ${n} accepted fix${n === 1 ? "" : "es"}:`}
        options={
          n === 0
            ? []
            : [
                ["y", "to the working tree"],
                ["b", "to a new branch"],
              ]
        }
        onCancel={done}
        onPick={(k) => {
          done();
          void session.apply(k === "b" ? { kind: "branch" } : { kind: "worktree" });
        }}
      />
    );
  }

  if (mode === "help") return <HelpOverlay width={width} height={height} onClose={done} />;
  if (mode === "actions" && current) {
    const items2: MenuItem[] = [
      { key: "p", label: "Propose a different fix", hint: "in $EDITOR or in words" },
      ...(current.fix ? [{ key: "e", label: "Edit the fix in $EDITOR" }] : []),
      { key: "w", label: "Ask a question about this finding" },
      { key: "r", label: "Re-check this file", hint: "runs the reviewer again on it" },
      { key: "y", label: "Copy as a prompt for another agent" },
      ...(current.userFix && !current.userFix.active
        ? [{ key: "u", label: "Use my fix instead of the AI's" }]
        : []),
      ...(current.aiFix && !current.aiFix.active ? [{ key: "k", label: "Keep the AI's fix" }] : []),
      ...(outcome ? [{ key: "v", label: "View the last proposal check" }] : []),
    ];
    const id = current.finding.id;
    return (
      <Menu
        title={`actions · ${current.finding.title}`}
        items={items2}
        width={width}
        height={height}
        onCancel={done}
        onPick={(k) => {
          done();
          if (k === "p") setMode("propose");
          else if (k === "e") void session.editFix(id);
          else if (k === "w") setMode("ask");
          else if (k === "r") void session.recheck(id);
          else if (k === "y") session.copyPrompt(id);
          else if (k === "u" && current.userFix) void session.useAnyway(current.userFix.id);
          else if (k === "k") void session.keepAi(id);
          else if (k === "v" && outcome) setScreen("proposal");
        }}
      />
    );
  }
  if (mode === "options") {
    const c = switcher?.current();
    const opts2: MenuItem[] = [
      ...(switcher && c
        ? [
            { key: "m", label: "Model", hint: c.model ?? "CLI default" },
            { key: "p", label: "Provider", hint: c.provider },
            { key: "e", label: "Reasoning effort", hint: c.effort ?? "CLI default" },
            { key: "d", label: "Review depth", hint: c.depth },
            { key: "s", label: "Save this as the default", hint: describeChoice(c) },
          ]
        : []),
      { key: "r", label: "Rules", hint: "turn rules on or off" },
    ];
    return (
      <Menu
        title="options · used by the next ask, proposal or re-check"
        items={opts2}
        width={width}
        height={height}
        onCancel={done}
        onPick={(k) => {
          done();
          if (k === "r") return setMode("rules");
          const key = { m: "m", p: "P", e: "E", d: "D", s: "S" }[k] as "m" | "P" | "E" | "D" | "S";
          switching.open(key);
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
  if (switching.overlay) return switching.overlay;
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {screen === "stream" || !current || !outcome ? (
        <StreamScreen
          state={state}
          items={items}
          filter={filter}
          query={query}
          cursor={cursor}
          expanded={expanded}
          fixTab={fixTab}
          fileCursor={fileCursor}
          focus={focus}
          width={width}
          height={height}
          prompt={prompt}
          idle={idle}
        />
      ) : (
        <ProposalScreen
          state={state}
          outcome={outcome}
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
