import type { ProposalOutcome } from "@crit/core";
import type { ReactNode } from "react";
import type {
  FindingView,
  ReviewSession,
  SessionState,
} from "@/features/review-session/model/session.ts";
import { Choice } from "@/shared/ui/choice.tsx";
import { TextInput } from "@/shared/ui/text-input.tsx";
import type { ReviewInput, ReviewMode } from "./review-mode.ts";

type Props = {
  mode: ReviewMode;
  current: FindingView | undefined;
  state: SessionState;
  session: ReviewSession;
  query: string;
  outcome: ProposalOutcome | undefined;
  lastInput: ReviewInput;
  onRerun?: (fresh: boolean) => void;
  setMode: (mode: ReviewMode) => void;
  setQuery: (query: string) => void;
  setCursor: (cursor: number) => void;
  setLastInput: (input: ReviewInput) => void;
  showOutcome: (outcome: ProposalOutcome | undefined) => void;
  done: () => void;
  exit: () => void;
};

export const reviewPrompt = ({
  mode,
  current,
  state,
  session,
  query,
  outcome,
  lastInput,
  onRerun,
  setMode,
  setQuery,
  setCursor,
  setLastInput,
  showOutcome,
  done,
  exit,
}: Props): ReactNode => {
  let prompt: ReactNode = null;
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
  if (mode === "instruct" && current)
    prompt = (
      <TextInput
        label={
          current.fix
            ? "Tell the AI how the fix should change ›"
            : "No fix yet. What should the fix do? (enter alone: let the AI decide) ›"
        }
        onCancel={done}
        onSubmit={(text) => {
          done();
          session.draftFix(current.finding.id, text.trim() || undefined);
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
          ["w", "describe it in words"],
          ["e", "write it in $EDITOR"],
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
      (findingView) =>
        findingView.finding.selected && findingView.finding.status === "open" && findingView.fix,
    ).length;
    prompt = (
      <Choice
        enterPicksFirst
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

  if (mode === "rerun" && onRerun)
    prompt = (
      <Choice
        label={`Re-run the review of ${state.review.scopeLabel}? Every file is reviewed again, without the cache.`}
        options={[["y", "yes, re-run"]]}
        onCancel={done}
        onPick={() => {
          done();
          onRerun(true);
          exit();
        }}
      />
    );
  return prompt;
};
