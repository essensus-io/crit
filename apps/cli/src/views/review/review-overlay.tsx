import type { ProposalOutcome } from "@crit/core";
import type { ReactNode } from "react";
import { describeChoice } from "../../features/model-switching/lib/describe-choice.ts";
import { type Switcher } from "../../features/model-switching/lib/create-switcher.ts";
import type { FindingView, ReviewSession } from "../../features/review-session/model/session.ts";
import { Menu, type MenuItem } from "../../shared/ui/menu.tsx";
import { Picker } from "../../shared/ui/picker.tsx";
import { HelpView } from "./help-view.tsx";
import type { ReviewMode } from "./review-mode.ts";

type Props = {
  mode: ReviewMode;
  current: FindingView | undefined;
  session: ReviewSession;
  switcher: Switcher | undefined;
  outcome: ProposalOutcome | undefined;
  width: number;
  height: number;
  hasRerun: boolean;
  setMode: (mode: ReviewMode) => void;
  setScreen: (screen: "stream" | "proposal") => void;
  openSwitching: (key: "m" | "p" | "e" | "d" | "s") => void;
  done: () => void;
};

export const reviewOverlay = ({
  mode,
  current,
  session,
  switcher,
  outcome,
  width,
  height,
  hasRerun,
  setMode,
  setScreen,
  openSwitching,
  done,
}: Props): ReactNode => {
  if (mode === "help") return <HelpView width={width} height={height} onClose={done} />;
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
      ...(hasRerun
        ? [
            {
              key: "n",
              label: "Re-run this review",
              hint: "same scope; only changed files cost tokens",
            },
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
          if (k === "n") return setMode("rerun");
          const key = k as "m" | "p" | "e" | "d" | "s";
          openSwitching(key);
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
  return undefined;
};
