import { shortId } from "@crit/schema";
import { Box, Text } from "ink";
import { useMemo } from "react";
import type { Line } from "./card.ts";
import { Footer, Status } from "./components.tsx";
import { fileTree, type ListFilter, triage } from "./filter.ts";
import type { FindingView, SessionState } from "./session.ts";
import { buildStream } from "./stream.ts";
import { T } from "./theme.ts";
import { Panel, truncate, Viewport } from "./widgets.tsx";

/** A row of styled segments as one terminal line. */
function Row({ line }: { line: Line }) {
  return (
    <Text>
      {line.map((s, i) => (
        <Text
          key={i}
          {...(s.color ? { color: s.color } : {})}
          {...(s.dim ? { dimColor: true } : {})}
          {...(s.bold ? { bold: true } : {})}
          {...(s.inverse ? { inverse: true } : {})}
        >
          {s.t}
        </Text>
      ))}
    </Text>
  );
}

/** What is left to do, for the line under the panels. */
export function progressOf(items: FindingView[]) {
  const live = items.filter((i) => triage(i) !== "applied");
  const reviewed = live.filter((i) => triage(i) !== "pending").length;
  const accepted = items.filter((i) => triage(i) === "accepted").length;
  const applicable = items.filter(
    (i) => i.finding.selected && i.finding.status === "open" && i.fix,
  ).length;
  return { total: live.length, reviewed, accepted, applicable };
}

export function StreamScreen(props: {
  state: SessionState;
  items: FindingView[];
  filter: ListFilter;
  query: string;
  cursor: number;
  expanded: ReadonlySet<string>;
  fixTab: "ai" | "user";
  fileCursor: number;
  focus: "files" | "stream";
  width: number;
  height: number;
  prompt?: React.ReactNode;
  /** Another screen has the keys (a menu, a prompt): the stream does not react to them. */
  idle: boolean;
}) {
  const { state, items, width, height } = props;
  const review = state.review;
  const current = items[Math.min(props.cursor, Math.max(0, items.length - 1))];
  const all = state.items.filter(
    (v) => !(v.finding.verdict === "rejected" || v.finding.status === "closed"),
  );
  const p = progressOf(all);
  const filtered = state.items.length - all.length;

  const leftW = Math.min(28, Math.max(20, Math.floor(width / 5)));
  const rightW = width - leftW - 1;
  const panelH = Math.max(5, height - 5);
  const rows = panelH - 2;
  const innerW = rightW - 4;
  const tree = fileCursorRows(state);

  const stream = useMemo(
    () =>
      buildStream({
        items,
        state,
        code: state.code,
        current: current?.finding.id,
        expanded: props.expanded,
        fixTab: props.fixTab,
        width: innerW - 1, // the scrollbar takes the last column
      }),
    [items, state, current?.finding.id, props.expanded, props.fixTab, innerW],
  );
  const span = current ? stream.card.get(current.finding.id) : undefined;
  const lines = stream.rows.map((r, i) => <Row key={i} line={r.line} />);
  const fstart = Math.max(
    0,
    Math.min(props.fileCursor - Math.floor(rows / 2), tree.length - (rows - 1)),
  );

  const keys: [string, string][] = !current
    ? [
        ["/", "search"],
        ["o", "options"],
        ["?", "help"],
        ["q", "quit"],
      ]
    : props.focus === "files"
      ? [
          ["j/k", "pick a file"],
          ["enter", "go to it"],
          ["l", "back to code"],
          ["?", "help"],
        ]
      : [
          ["j/k", "next"],
          ["a", current.fix ? (current.finding.selected ? "undo" : "accept") : "get a fix"],
          ["d", triage(current) === "dismissed" ? "restore" : "dismiss"],
          ["enter", props.expanded.has(current.finding.id) ? "less" : "more"],
          ...(p.applicable > 0 ? ([["A", `apply ${p.applicable}`]] as [string, string][]) : []),
          [".", "actions"],
          ["?", "help"],
        ];

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Text wrap="truncate">
        <Text bold color={T.mint}>
          {" "}
          crit
        </Text>
        <Text dimColor> · review </Text>
        <Text>{shortId(review.id)}</Text>
        <Text dimColor> · </Text>
        <Text>{review.scopeLabel}</Text>
        <Text dimColor>{` · ${review.provider}${review.model ? ` (${review.model})` : ""}`}</Text>
        {props.query ? <Text color={T.cyan}>{`  /${props.query}`}</Text> : null}
        {props.filter.tab === "filtered" ? <Text color={T.yellow}>{"  (filtered)"}</Text> : null}
      </Text>
      <Box width={width} height={panelH}>
        <Panel
          title="files"
          tone={props.focus === "files" ? "orange" : "mint"}
          width={leftW}
          height={panelH}
        >
          {tree.slice(fstart, fstart + rows - 1).map((r, k) => {
            const i = fstart + k;
            const here = r.file !== undefined && r.file === current?.finding.file;
            return (
              <Text
                key={r.key}
                wrap="truncate"
                {...(props.focus === "files" && i === props.fileCursor ? { inverse: true } : {})}
                {...(here ? { color: T.cyan } : {})}
              >
                {truncate(r.label, leftW - 9).padEnd(leftW - 8)}
                {String(r.count).padStart(3)}
              </Text>
            );
          })}
          {filtered > 0 ? <Text dimColor>{`+${filtered} filtered`}</Text> : null}
        </Panel>
        <Box width={1} />
        <Panel
          title={
            current ? `${current.finding.file}  ${props.cursor + 1}/${items.length}` : "findings"
          }
          tone={props.focus === "stream" ? "orange" : "mint"}
          width={rightW}
          height={panelH}
        >
          {items.length === 0 ? (
            <Text dimColor>
              {state.items.length === 0
                ? "No findings. Nothing to review."
                : props.filter.tab === "filtered"
                  ? "Nothing filtered."
                  : "No findings match. Clear the search with / and enter."}
            </Text>
          ) : (
            <Viewport
              lines={lines}
              height={rows}
              width={innerW}
              vim={false}
              active={props.focus === "stream" && props.idle}
              {...(span && current
                ? {
                    reveal: {
                      key: `${current.finding.id}:${props.expanded.has(current.finding.id)}:${props.fixTab}`,
                      from: Math.max(0, span.from - 5),
                      to: span.to,
                    },
                  }
                : {})}
            />
          )}
        </Panel>
      </Box>
      {state.busy || state.notice || state.error ? (
        <Status busy={state.busy} notice={state.notice} error={state.error} />
      ) : (
        <Text wrap="truncate">
          {" "}
          <Text color={T.mint}>{`${p.reviewed} of ${p.total} reviewed`}</Text>
          <Text dimColor> · </Text>
          <Text color={T.orange}>{`${p.accepted} accepted`}</Text>
          {p.total > 0 && p.reviewed === p.total ? (
            <Text dimColor>
              {p.applicable > 0
                ? `  ·  all triaged: A applies ${p.applicable}`
                : "  ·  all triaged: q to finish"}
            </Text>
          ) : null}
        </Text>
      )}
      {props.prompt ?? <Text> </Text>}
      <Footer width={width} keys={keys} />
    </Box>
  );
}

const fileCursorRows = fileTree;
