import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { diffRows, Footer, HRule, Status } from "./components.tsx";
import type { FindingView, SessionState } from "./session.ts";
import { describeChoiceParts, type Choice } from "./switcher.ts";
import { SEV_COLOR, T } from "./theme.ts";
import { StatusBar, Viewport, wrapText } from "./widgets.tsx";

const SEVERITY_WORD = { critical: "CRITICAL", major: "MAJOR", minor: "MINOR", nit: "NIT" } as const;

/** Fixed-width label column, built as a string so formatting cannot collapse it. */
const LABEL = (s: string) => s.padEnd(12);

const rule = (title: string, width: number): ReactNode => (
  <Text color={T.lav}>{`╌╌ ${title} ${"╌".repeat(Math.max(0, width - title.length - 5))}`}</Text>
);

/** Every line of a finding as one terminal row, so a long finding scrolls inside its box. */
export function detailLines(
  item: FindingView,
  state: SessionState,
  fixTab: "ai" | "user",
  width: number,
): ReactNode[] {
  const f = item.finding;
  const w = Math.max(20, width - 3);
  const lines: ReactNode[] = [];
  const text = (s: string, props: object = {}) =>
    wrapText(s, w).forEach((l) => lines.push(<Text {...props}> {l}</Text>));
  const blank = () => lines.push(<Text> </Text>);
  const rules = f.ruleIds.map((id) => state.rules.get(id) ?? { id, title: "", path: "" });
  const shown = fixTab === "user" ? item.userFix : item.aiFix;

  text(f.title, { bold: true });
  blank();
  text(f.explanation);
  if (f.failureScenario) {
    blank();
    lines.push(
      <Text>
        {" "}
        <Text dimColor>{LABEL("Fails when")}</Text>
      </Text>,
    );
    text(f.failureScenario);
  }
  if (rules.length || f.verdictReason) blank();
  for (const r of rules)
    lines.push(
      <Text key={r.id}>
        {" "}
        <Text dimColor>{LABEL("Rule")}</Text>
        {`${r.id} ${r.title}`}
        {r.path ? (
          <Text
            dimColor
          >{`  (${"section" in r && r.section ? `${r.path} §${r.section}` : r.path})`}</Text>
        ) : null}
      </Text>,
    );
  if (f.verdictReason)
    lines.push(
      <Text>
        {" "}
        <Text dimColor>{LABEL("Skeptic")}</Text>
        {f.verdictReason}
      </Text>,
    );
  blank();
  lines.push(rule("Fix", width));
  lines.push(
    <Text>
      {" "}
      <Text {...(fixTab === "ai" ? { inverse: true } : {})}>
        [ AI {item.aiFix ? (item.fix?.id === item.aiFix.id ? "●" : "○") : "–"} ]
      </Text>{" "}
      <Text {...(fixTab === "user" ? { inverse: true } : {})}>
        [ yours {item.userFix ? (item.fix?.id === item.userFix.id ? "●" : "○") : "–"} ]
      </Text>
      {shown?.evaluation ? (
        <Text
          dimColor
        >{`  ${shown.evaluation.toUpperCase()}${shown.overridden ? " (used anyway)" : ""}`}</Text>
      ) : null}
      {shown?.verify ? (
        <Text
          color={shown.verify.passed ? T.mint : T.red}
        >{`  verify ${shown.verify.passed ? "✓" : "✗"}`}</Text>
      ) : null}
    </Text>,
  );
  if (shown) {
    text(shown.summary, { dimColor: true });
    lines.push(...diffRows(shown.patch));
  } else
    text(
      fixTab === "user"
        ? "No fix of yours yet. Press p to propose one."
        : "The reviewer proposed no fix.",
      {
        dimColor: true,
      },
    );
  blank();
  lines.push(rule(`Thread (${item.messages.length})`, width));
  for (const m of item.messages) {
    const body = m.body.replace(/^\[(evaluation|override)\] /, "");
    wrapText(body, w - 4).forEach((l, i) =>
      lines.push(
        <Text>
          {" "}
          {i === 0 ? (
            <Text bold color={m.role === "ai" ? T.lav : T.cyan}>
              {m.role === "ai" ? "AI " : "you"}
            </Text>
          ) : (
            "   "
          )}{" "}
          {l}
        </Text>,
      ),
    );
  }
  return lines;
}

export function DetailScreen(props: {
  state: SessionState;
  item: FindingView;
  fixTab: "ai" | "user";
  width: number;
  height: number;
  prompt?: ReactNode;
  position: string;
  choice?: Choice;
}) {
  const { item, state, width, height, fixTab } = props;
  const f = item.finding;
  const range =
    f.range.start === f.range.end ? `${f.range.start}` : `${f.range.start}–${f.range.end}`;
  // header 1 · rule 1 · body · status 1 · prompt 1 · footer 2
  const body = Math.max(3, height - 6);
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Box justifyContent="space-between" width={width}>
        <Text wrap="truncate">
          {" "}
          <Text bold>{`${f.file}:${range}`}</Text>
          <Text dimColor> · </Text>
          <Text color={SEV_COLOR[f.severity]}>{SEVERITY_WORD[f.severity]}</Text>
          <Text
            dimColor
          >{` · ${f.category} · confidence ${f.confidence.toFixed(2)}${f.verdict ? ` · ${f.verdict}` : ""}`}</Text>
        </Text>
        <Text wrap="truncate">
          <Text dimColor>{`${props.position}  `}</Text>
          {f.status === "dismissed" ? (
            <Text color={T.yellow}>{`[dismissed: ${f.dismissReason}] `}</Text>
          ) : (
            <Text bold>{`${f.selected ? "[x]" : "[ ]"} include `}</Text>
          )}
        </Text>
      </Box>
      <HRule width={width} />
      <Viewport
        lines={detailLines(item, state, fixTab, width)}
        height={body}
        width={width}
        resetKey={`${f.id}:${fixTab}`}
        active={!props.prompt}
      />
      {state.busy || state.notice || state.error || !props.choice ? (
        <Status busy={state.busy} notice={state.notice} error={state.error} />
      ) : (
        <StatusBar width={width} items={describeChoiceParts(props.choice)} />
      )}
      {props.prompt ?? <Text> </Text>}
      <Footer
        width={width}
        keys={[
          ["space", "include"],
          ["e", "edit fix"],
          ["p", "propose"],
          ["?", "ask"],
          ["d", "dismiss"],
          ["r", "re-check"],
          ["tab", "AI/yours"],
          ["n/N", "next"],
          ["j/k", "scroll"],
          ["m", "model"],
          ["P", "provider"],
          ["esc", "back"],
        ]}
      />
    </Box>
  );
}
