import type { ProposalOutcome } from "@crit/core";
import { Box, Text } from "ink";
import { DiffView, Footer, HRule, Status } from "./components.tsx";
import type { SessionState } from "./session.ts";

const VERDICT_COLOR = { accepted: "green", concerns: "yellow", rejected: "red" } as const;

/** The result of checking a user proposal: verdict, the user's diff, the AI's reply and a reply box. */
export function ProposalScreen(props: {
  state: SessionState;
  outcome: ProposalOutcome;
  width: number;
  input?: React.ReactNode;
}) {
  const { outcome, width, state } = props;
  const e = outcome.evaluation;
  const verify = outcome.verify;
  return (
    <Box flexDirection="column" width={width}>
      <Text>
        {" "}
        <Text bold>Your fix</Text> · {outcome.fix.active ? "checked" : "not applied"} ·{" "}
        <Text color={VERDICT_COLOR[e.verdict]} bold>
          {e.verdict.toUpperCase()}
        </Text>
        <Text dimColor>{`   round ${outcome.round}/3`}</Text>
        {verify ? (
          <Text>
            {"   "}verify:{" "}
            {verify.commands.map((c) => (
              <Text key={c.command} {...(c.exitCode === 0 ? { color: "green" } : { color: "red" })}>
                {c.command.split(" ").slice(-1)[0]} {c.exitCode === 0 ? "✓" : "✗"}{" "}
              </Text>
            ))}
          </Text>
        ) : null}
      </Text>
      <HRule width={width} />
      {outcome.drafted ? <Text dimColor> Drafted from your description:</Text> : null}
      <DiffView patch={outcome.fix.patch} maxLines={14} />
      <Text> </Text>
      <Box paddingLeft={1} width={width - 2}>
        <Text>
          <Text bold color="magenta">
            AI{" "}
          </Text>{" "}
          {e.reason}
          {e.failingCase ? `\n     Fails when: ${e.failingCase}` : ""}
          {e.verdict === "concerns" && e.question ? `\n     ${e.question}` : ""}
        </Text>
      </Box>
      <Text> </Text>
      {e.verdict === "concerns" && !outcome.finalRound ? (props.input ?? null) : null}
      {outcome.finalRound && e.verdict !== "accepted" ? (
        <Text color="yellow">
          {" "}
          Three rounds used. Pick a fix: u use yours anyway or k keep the AI fix.
        </Text>
      ) : null}
      <Status busy={state.busy} notice={state.notice} error={state.error} />
      <Footer
        width={width}
        keys={[
          ...(e.verdict === "concerns" && !outcome.finalRound
            ? ([["enter", "reply"]] as [string, string][])
            : []),
          ...(e.verdict !== "accepted" ? ([["u", "use anyway"]] as [string, string][]) : []),
          ["k", "keep AI fix"],
          ["esc", "back"],
        ]}
      />
    </Box>
  );
}
