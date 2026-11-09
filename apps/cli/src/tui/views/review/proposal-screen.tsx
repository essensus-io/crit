import type { ProposalOutcome } from "@crit/core";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { diffRows, Footer, HRule, Status } from "../../shared/ui/index.ts";
import type { SessionState } from "../../features/review-session/index.ts";
import { T } from "../../shared/lib/index.ts";
import { Viewport } from "../../shared/ui/index.ts";
import { wrapText } from "../../shared/lib/index.ts";

const VERDICT_COLOR = { accepted: T.mint, concerns: T.yellow, rejected: T.red } as const;

/** The result of checking a user proposal: verdict, the user's diff, the AI's reply and a reply box. */
export function ProposalScreen(props: {
  state: SessionState;
  outcome: ProposalOutcome;
  width: number;
  height: number;
  input?: ReactNode;
}) {
  const { outcome, width, height, state } = props;
  const e = outcome.evaluation;
  const verify = outcome.verify;
  const w = Math.max(20, width - 8);
  const lines: ReactNode[] = [];
  if (outcome.drafted) lines.push(<Text dimColor> Drafted from your description:</Text>);
  lines.push(...diffRows(outcome.fix.patch));
  lines.push(<Text> </Text>);
  const ai = [
    e.reason,
    ...(e.failingCase ? [`Fails when: ${e.failingCase}`] : []),
    ...(e.verdict === "concerns" && e.question ? [e.question] : []),
  ];
  let first = true;
  for (const para of ai)
    for (const l of wrapText(para, w)) {
      lines.push(
        <Text>
          {" "}
          {first ? (
            <Text bold color={T.lav}>
              AI{" "}
            </Text>
          ) : (
            "   "
          )}{" "}
          {l}
        </Text>,
      );
      first = false;
    }
  if (outcome.finalRound && e.verdict !== "accepted") {
    lines.push(<Text> </Text>);
    lines.push(
      <Text color={T.yellow}>
        {" "}
        Three rounds used. Pick a fix: u use yours anyway or k keep the AI fix.
      </Text>,
    );
  }
  // header 1 · rule 1 · body · input 1 · status 1 · footer 2
  const body = Math.max(3, height - 6);
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Text wrap="truncate">
        {" "}
        <Text bold>Your fix</Text>
        {` · ${outcome.fix.active ? "checked" : "not applied"} · `}
        <Text bold color={VERDICT_COLOR[e.verdict]}>
          {e.verdict.toUpperCase()}
        </Text>
        <Text dimColor>{`   round ${outcome.round}/3`}</Text>
        {verify ? (
          <Text>
            {"   verify: "}
            {verify.commands.map((c) => (
              <Text key={c.command} color={c.exitCode === 0 ? T.mint : T.red}>
                {`${c.command.split(" ").slice(-1)[0]} ${c.exitCode === 0 ? "✓" : "✗"} `}
              </Text>
            ))}
          </Text>
        ) : null}
      </Text>
      <HRule width={width} />
      <Viewport
        lines={lines}
        height={body}
        width={width}
        resetKey={outcome.fix.id}
        active={!props.input}
      />
      {e.verdict === "concerns" && !outcome.finalRound ? (
        (props.input ?? <Text> </Text>)
      ) : (
        <Text> </Text>
      )}
      <Status busy={state.busy} notice={state.notice} error={state.error} />
      <Footer
        width={width}
        keys={[
          ...(e.verdict === "concerns" && !outcome.finalRound
            ? ([["enter", "reply"]] as [string, string][])
            : []),
          ...(e.verdict !== "accepted" ? ([["u", "use anyway"]] as [string, string][]) : []),
          ["k", "keep AI fix"],
          ["j/k", "scroll"],
          ["esc", "back"],
        ]}
      />
    </Box>
  );
}
