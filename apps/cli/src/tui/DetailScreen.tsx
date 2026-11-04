import { Box, Text } from "ink";
import { DiffView, Footer, HRule, Status } from "./components.tsx";
import type { FindingView, SessionState } from "./session.ts";

/** Fixed-width label column, built as a string so formatting cannot collapse it. */
const LABEL = (s: string) => s.padEnd(12);

const SEVERITY_WORD = { critical: "CRITICAL", major: "MAJOR", minor: "MINOR", nit: "NIT" } as const;

export function DetailScreen(props: {
  state: SessionState;
  item: FindingView;
  fixTab: "ai" | "user";
  width: number;
  prompt?: React.ReactNode;
  position: string;
}) {
  const { item, state, width, fixTab } = props;
  const f = item.finding;
  const range =
    f.range.start === f.range.end ? `${f.range.start}` : `${f.range.start}–${f.range.end}`;
  const shown = fixTab === "user" ? item.userFix : item.aiFix;
  const rules = f.ruleIds.map((id) => state.rules.get(id) ?? { id, title: "", path: "" });
  const thread = item.messages;
  return (
    <Box flexDirection="column" width={width}>
      <Text>
        {" "}
        <Text bold>
          {f.file}:{range}
        </Text>{" "}
        · {SEVERITY_WORD[f.severity]} · {f.category} · confidence {f.confidence.toFixed(2)}
        {f.verdict ? ` · ${f.verdict}` : ""}
        <Text dimColor>{`   ${props.position}`}</Text>
        {"   "}
        {f.status === "dismissed" ? (
          <Text color="yellow">[dismissed: {f.dismissReason}]</Text>
        ) : (
          <Text bold>{f.selected ? "[x]" : "[ ]"} include</Text>
        )}
      </Text>
      <HRule width={width} />
      <Text bold> {f.title}</Text>
      <Text> </Text>
      <Box paddingLeft={1} width={width - 2}>
        <Text>{f.explanation}</Text>
      </Box>
      <Text> </Text>
      {f.failureScenario ? (
        <Text>
          {" "}
          <Text dimColor>{LABEL("Fails when")}</Text>
          {f.failureScenario}
        </Text>
      ) : null}
      {rules.map((r) => (
        <Text key={r.id}>
          {" "}
          <Text dimColor>{LABEL("Rule")}</Text>
          {`${r.id} ${r.title}`}
          {r.path ? (
            <Text dimColor>{`  (${r.section ? `${r.path} §${r.section}` : r.path})`}</Text>
          ) : null}
        </Text>
      ))}
      {f.verdictReason ? (
        <Text>
          {" "}
          <Text dimColor>{LABEL("Skeptic")}</Text>
          {f.verdictReason}
        </Text>
      ) : null}
      <Text> </Text>
      <Text>
        {" "}
        <Text bold>Fix</Text>
        {"  "}
        <Text {...(fixTab === "ai" ? { inverse: true } : {})}>
          [ AI {item.aiFix ? (item.fix?.id === item.aiFix.id ? "●" : "○") : "–"} ]
        </Text>{" "}
        <Text {...(fixTab === "user" ? { inverse: true } : {})}>
          [ yours {item.userFix ? (item.fix?.id === item.userFix.id ? "●" : "○") : "–"} ]
        </Text>
        {shown?.evaluation ? (
          <Text dimColor>
            {" "}
            {shown.evaluation.toUpperCase()}
            {shown.overridden ? " (used anyway)" : ""}
          </Text>
        ) : null}
        {shown?.verify ? (
          <Text {...(shown.verify.passed ? { color: "green" } : { color: "red" })}>
            {" "}
            verify {shown.verify.passed ? "✓" : "✗"}
          </Text>
        ) : null}
      </Text>
      {shown ? (
        <>
          <Text dimColor> {shown.summary}</Text>
          <DiffView patch={shown.patch} maxLines={18} />
        </>
      ) : (
        <Text dimColor>
          {" "}
          {fixTab === "user"
            ? "No fix of yours yet. Press p to propose one."
            : "The reviewer proposed no fix."}
        </Text>
      )}
      <Text> </Text>
      <Text bold> Thread ({thread.length})</Text>
      {thread.slice(-6).map((m) => (
        <Box key={m.id} paddingLeft={1} width={width - 2}>
          <Text>
            <Text bold color={m.role === "ai" ? "magenta" : "cyan"}>
              {m.role === "ai" ? "AI " : "you"}
            </Text>{" "}
            {m.body.replace(/^\[(evaluation|override)\] /, "")}
          </Text>
        </Box>
      ))}
      <Status busy={state.busy} notice={state.notice} error={state.error} />
      {props.prompt ?? null}
      <Footer
        width={width}
        keys={[
          ["space", "include"],
          ["e", "edit fix"],
          ["p", "propose better fix"],
          ["?", "ask"],
          ["d", "dismiss"],
          ["r", "re-check"],
          ["tab", "AI/yours"],
          ["n/N", "next/prev"],
          ["esc", "back"],
        ]}
      />
    </Box>
  );
}
