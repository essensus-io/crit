import { shortId } from "@crit/schema";
import { Box, Text } from "ink";
import { useMemo } from "react";
import type { Line } from "../../features/review-session/index.ts";
import { Footer, Status } from "../../shared/ui/index.ts";
import { fileTree, type ListFilter, triage } from "../../features/review-session/index.ts";
import type { FindingView, SessionState } from "../../features/review-session/index.ts";
import { buildStream } from "../../features/review-session/index.ts";
import { SPINNER, T } from "../../shared/lib/index.ts";
import { Panel, truncate, useTick, Viewport } from "../../shared/ui/index.ts";

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

/** Drop the least important hints, in this order, until the line fits. */
function fitKeys(keys: [string, string][], width: number): [string, string][] {
  const size = (ks: [string, string][]) =>
    ks.reduce((n, [k, l], i) => n + (i ? 3 : 0) + k.length + l.length + 1, 1);
  const out = [...keys];
  for (const drop of ["?", "r", "i"])
    if (size(out) > width) {
      const at = out.findIndex(([k]) => k === drop);
      if (at >= 0) out.splice(at, 1);
    }
  return out;
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
  focus: "files" | "stream";
  width: number;
  height: number;
  prompt?: React.ReactNode;
  /** Another screen has the keys (a menu, a prompt): the stream does not react to them. */
  idle: boolean;
  /** Show the re-run hint. */
  canRerun?: boolean;
  /** q goes back to the start screen (instead of quitting). */
  canGoBack?: boolean;
  /** Findings the cursor has been on. */
  seenCount?: number;
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
  const tree = fileTree(state);
  // the files list follows the finding you are on, so it always shows where you are
  const fileCursor = Math.max(
    0,
    tree.findIndex((r) => r.file !== undefined && r.file === current?.finding.file),
  );

  const drafting = useMemo(() => new Set(state.drafting), [state.drafting]);
  const tick = useTick(150, drafting.size > 0);
  const spin = drafting.size ? SPINNER[tick % SPINNER.length] : undefined;
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
        drafting,
        ...(spin ? { spin } : {}),
      }),
    [items, state, current?.finding.id, props.expanded, props.fixTab, innerW, drafting, spin],
  );
  const span = current ? stream.card.get(current.finding.id) : undefined;
  const lines = stream.rows.map((r, i) => <Row key={i} line={r.line} />);
  const fstart = Math.max(0, Math.min(fileCursor - Math.floor(rows / 2), tree.length - (rows - 1)));

  const keys: [string, string][] = !current
    ? [
        ["/", "search"],
        ...(props.canRerun ? ([["r", "re-run review"]] as [string, string][]) : []),
        ["o", "options"],
        ["?", "help"],
        ["q", props.canGoBack ? "start screen" : "quit"],
      ]
    : props.focus === "files"
      ? [
          ["j/k", "previous / next file"],
          ["enter", "back to the code"],
          ["q", props.canGoBack ? "start screen" : "quit"],
        ]
      : fitKeys(
          [
            ["j/k", "next"],
            ["space", current.finding.selected ? "uncheck" : current.fix ? "fix it" : "get a fix"],
            ["i", current.fix ? "change the fix" : "tell the AI the fix"],
            ["enter", p.applicable > 0 ? `apply ${p.applicable} checked` : "finish"],
            ...(props.canRerun ? ([["r", "re-run"]] as [string, string][]) : []),
            ["q", props.canGoBack ? "start screen" : "quit"],
            ["?", "help"],
          ],
          width,
        );

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
                {...(props.focus === "files" && i === fileCursor ? { inverse: true } : {})}
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
                ? state.omitted.length > 0
                  ? `No findings kept. The agent reported ${state.omitted.length} that crit left out:\n${state.omitted
                      .slice(0, 6)
                      .map((o) => `  · ${o}`)
                      .join("\n")}`
                  : "No findings. Files unchanged since an earlier review reuse its result, and findings you marked won't fix stay hidden. Press r to review every file again."
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
              arrows={false}
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
          <Text color={T.mint}>{`${props.seenCount ?? p.reviewed} of ${p.total} looked at`}</Text>
          <Text dimColor> · </Text>
          <Text color={T.orange}>{`${p.accepted} accepted`}</Text>
          {drafting.size ? (
            <Text
              color={T.orange}
            >{`  ·  ${spin} writing ${drafting.size} fix${drafting.size === 1 ? "" : "es"}`}</Text>
          ) : null}
          {state.omitted.length > 0 ? (
            <Text color={T.yellow}>{`  ·  ${state.omitted.length} left out`}</Text>
          ) : null}
          {props.canRerun ? <Text dimColor>{"  ·  r re-run review"}</Text> : null}
          {p.total > 0 && (props.seenCount ?? 0) >= p.total ? (
            <Text dimColor>
              {p.applicable > 0
                ? `  ·  enter applies ${p.applicable}`
                : "  ·  nothing checked: q to finish"}
            </Text>
          ) : null}
        </Text>
      )}
      {props.prompt ?? <Text> </Text>}
      <Footer width={width} keys={keys} />
    </Box>
  );
}
