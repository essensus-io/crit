import type { ProposalOutcome } from "@crit/core";
import { Box, useApp } from "ink";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type Switcher, useSwitching } from "../../features/model-switching/index.ts";
import {
  parseQuery,
  type ReviewSession,
  visibleItems,
} from "../../features/review-session/index.ts";
import { useScreen } from "../../shared/ui/index.ts";
import { ProposalView } from "./proposal-view.tsx";
import type { ReviewInput, ReviewMode } from "./review-mode.ts";
import { reviewOverlay } from "./review-overlay.tsx";
import { reviewPrompt } from "./review-prompt.tsx";
import { StreamView } from "./stream-view.tsx";
import { useReviewKeys } from "./use-review-keys.ts";

type Props = {
  session: ReviewSession;
  onExit?: () => void;
  switcher?: Switcher;
  onConnect?: () => void;
  onRerun?: (fresh: boolean) => void;
  onBack?: () => void;
};

export const ReviewView = ({ session, onExit, switcher, onConnect, onRerun, onBack }: Props) => {
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
  const [focus, setFocus] = useState<"files" | "stream">("stream");
  const [mode, setMode] = useState<ReviewMode>("none");
  const [fixTab, setFixTab] = useState<"ai" | "user">("ai");
  const [outcome, setOutcome] = useState<ProposalOutcome | undefined>();
  const [lastInput, setLastInput] = useState<ReviewInput>();

  const filter = useMemo(() => parseQuery(query), [query]);
  const items = useMemo(() => visibleItems(state, filter), [state, filter]);
  const current = items[Math.min(cursor, Math.max(0, items.length - 1))];
  const busy = Boolean(state.busy);
  const expanded = useMemo<ReadonlySet<string>>(
    () => new Set(current ? [current.finding.id] : []),
    [current?.finding.id],
  );
  useEffect(() => {
    if (current?.fix) setFixTab(current.fix.author === "user" ? "user" : "ai");
  }, [current?.finding.id, current?.fix?.id]);
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const id = current?.finding.id;
    if (id && !seen.has(id)) setSeen((s) => new Set(s).add(id));
  }, [current?.finding.id]);
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

  useEffect(() => {
    for (const id of wanted.current) {
      if (state.drafting.includes(id)) continue;
      const it = state.items.find((v) => v.finding.id === id);
      if (!it) continue;
      if (!it.fix) continue;
      wanted.current.delete(id);
      if (!it.finding.selected) void session.toggle(id);
    }
  }, [state]);

  const wasDrafting = useRef<string[]>([]);
  const wanted = useRef(new Set<string>());
  useEffect(() => {
    const finished = wasDrafting.current.filter((id) => !state.drafting.includes(id));
    wasDrafting.current = state.drafting;
    const here = current?.finding.id;
    if (here && finished.includes(here) && current?.aiFix) {
      setFixTab("ai");
    }
  }, [state.drafting, current]);

  const quit = () => {
    onExit?.();
    app.exit();
  };
  const back = () => {
    onBack?.();
    app.exit();
  };
  const files = useMemo(() => [...new Set(items.map((i) => i.finding.file))], [items]);
  const showOutcome = (o: ProposalOutcome | undefined) => {
    if (!o) return;
    setOutcome(o);
    setScreen("proposal");
  };
  const done = () => setMode("none");
  const idle = mode === "none" && !switching.modal && !busy;

  useReviewKeys({
    session,
    state,
    items,
    files,
    current,
    cursor,
    query,
    focus,
    screen,
    outcome,
    seen,
    wanted,
    busy,
    isActive: mode === "none" && !switching.modal,
    canRerun: Boolean(onRerun),
    canGoBack: Boolean(onBack),
    setCursor,
    setQuery,
    setFocus,
    setFixTab,
    setMode,
    setScreen,
    quit,
    back,
  });

  const prompt = reviewPrompt({
    mode,
    current,
    state,
    session,
    query,
    outcome,
    lastInput,
    ...(onRerun ? { onRerun } : {}),
    setMode,
    setQuery,
    setCursor,
    setLastInput,
    showOutcome,
    done,
    exit: () => app.exit(),
  });
  const overlay = reviewOverlay({
    mode,
    current,
    session,
    switcher,
    outcome,
    width,
    height,
    hasRerun: Boolean(onRerun),
    setMode,
    setScreen,
    openSwitching: switching.open,
    done,
  });
  if (overlay) return overlay;
  if (switching.overlay) return switching.overlay;
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {screen === "stream" || !current || !outcome ? (
        <StreamView
          state={state}
          items={items}
          filter={filter}
          query={query}
          cursor={cursor}
          expanded={expanded}
          fixTab={fixTab}
          focus={focus}
          width={width}
          height={height}
          prompt={prompt}
          idle={idle}
          canRerun={Boolean(onRerun)}
          canGoBack={Boolean(onBack)}
          seenCount={items.filter((i) => seen.has(i.finding.id) || i === current).length}
        />
      ) : (
        <ProposalView
          state={state}
          outcome={outcome}
          width={width}
          height={height}
          input={prompt}
        />
      )}
    </Box>
  );
};
