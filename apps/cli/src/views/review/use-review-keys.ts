import type { ProposalOutcome } from "@crit/core";
import { useInput } from "ink";
import type { MutableRefObject } from "react";
import {
  type FindingView,
  type ReviewSession,
  type SessionState,
} from "@/features/review-session/model/session.ts";
import { triage } from "@/features/review-session/lib/triage.ts";
import type { ReviewMode } from "./review-mode.ts";

type Props = {
  session: ReviewSession;
  state: SessionState;
  items: FindingView[];
  files: string[];
  current: FindingView | undefined;
  cursor: number;
  query: string;
  focus: "files" | "stream";
  screen: "stream" | "proposal";
  outcome: ProposalOutcome | undefined;
  seen: ReadonlySet<string>;
  wanted: MutableRefObject<Set<string>>;
  busy: boolean;
  isActive: boolean;
  canRerun: boolean;
  canGoBack: boolean;
  setCursor: (cursor: number) => void;
  setQuery: (query: string) => void;
  setFocus: (focus: "files" | "stream") => void;
  setFixTab: (update: (tab: "ai" | "user") => "ai" | "user") => void;
  setMode: (mode: ReviewMode) => void;
  setScreen: (screen: "stream" | "proposal") => void;
  quit: () => void;
  back: () => void;
};

export const useReviewKeys = ({
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
  isActive,
  canRerun,
  canGoBack,
  setCursor,
  setQuery,
  setFocus,
  setFixTab,
  setMode,
  setScreen,
  quit,
  back,
}: Props) => {
  const moveFile = (delta: number) => {
    if (!current) return;
    const at = files.indexOf(current.finding.file);
    const target = files[Math.max(0, Math.min(files.length - 1, at + delta))];
    const first = items.findIndex((i) => i.finding.file === target);
    if (first >= 0) setCursor(first);
  };
  const finish = () => {
    const open = items.filter((i) => triage(i) !== "applied" && triage(i) !== "dismissed");
    const unseen = open.filter((i) => !seen.has(i.finding.id) && i !== current);
    if (unseen.length > 0) {
      const at = items.findIndex((i) => i.finding.id === unseen[0]!.finding.id);
      if (at >= 0) setCursor(at);
      return session.notify(
        `${unseen.length} finding${unseen.length === 1 ? "" : "s"} not looked at yet. j moves on; check with space or leave unchecked.`,
      );
    }
    const n = state.items.filter(
      (findingView) =>
        findingView.finding.selected && findingView.finding.status === "open" && findingView.fix,
    ).length;
    if (n === 0) return session.notify("Nothing is checked, so nothing to apply. q goes back.");
    void session.apply({ kind: "worktree" });
  };
  const move = (to: number) => setCursor(Math.max(0, Math.min(items.length - 1, to)));

  useInput(
    (typed, key) => {
      const input = typed.toLowerCase();
      if (busy) return;
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
      if (input === "q") return canGoBack ? back() : quit();
      if (input === "?") return setMode("help");
      if (input === "/") return setMode("search");
      if (input === "o") return setMode("options");
      if (input === "r" && canRerun) return setMode("rerun");
      if (key.escape) {
        if (query) {
          setQuery("");
          return setCursor(0);
        }
        return;
      }
      if (input === "h" || key.leftArrow) return setFocus("files");
      if (input === "l" || key.rightArrow) return setFocus("stream");
      if (focus === "files") {
        if (key.escape || key.return) return setFocus("stream");
        if (input === "j" || key.downArrow) return moveFile(1);
        if (input === "k" || key.upArrow) return moveFile(-1);
        return;
      }
      if (input === "j" || input === "n" || key.downArrow) return move(cursor + 1);
      if (input === "k" || key.upArrow) return move(cursor - 1);
      if (input === "]") return moveFile(1);
      if (input === "[") return moveFile(-1);
      if (input === "g") return move(0);
      if (input === "p") return setMode("apply");
      if (!current) return;
      const id = current.finding.id;
      if (key.tab && key.shift) return moveFile(-1);
      if (key.tab)
        return current.aiFix && current.userFix
          ? setFixTab((t) => (t === "ai" ? "user" : "ai"))
          : moveFile(1);
      if (key.return) return finish();
      if (input === "y") return void session.copyPrompt(id);
      if (input === ".") return setMode("actions");
      if (input === "i") return setMode("instruct");
      if (input === "x") return void session.applyOne(id);
      if (input === " ") {
        if (triage(current) === "dismissed") return void session.restore(id);
        const next = () => move(cursor + 1);
        if (current.finding.selected) return void session.toggle(id);
        if (current.fix) {
          void session.toggle(id).then(next);
          return;
        }
        if (state.drafting.includes(id))
          return session.notify("Already writing a fix for this one.");
        wanted.current.add(id);
        session.draftFix(id);
        return next();
      }
      if (input === "a") {
        if (triage(current) === "dismissed") return void session.restore(id);
        if (!current.fix && !current.finding.selected) return setMode("instruct");
        return void session.toggle(id);
      }
      if (input === "d")
        return triage(current) === "dismissed" ? void session.restore(id) : setMode("dismiss");
    },
    { isActive },
  );
};
