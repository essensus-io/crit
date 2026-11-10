import { shortId } from "@crit/schema";
import { Box, Text } from "ink";
import { useMemo } from "react";
import type { Line } from "@/features/review-session/lib/finding-card.ts";
import { Footer } from "@/shared/ui/footer.tsx";
import { Status } from "@/shared/ui/status.tsx";
import { fileTree } from "@/features/review-session/lib/file-tree.ts";
import { type ListFilter } from "@/features/review-session/lib/parse-query.ts";
import { triage } from "@/features/review-session/lib/triage.ts";
import type { FindingView, SessionState } from "@/features/review-session/model/session.ts";
import { buildStream } from "@/features/review-session/lib/stream.ts";
import { SPINNER, T } from "@/shared/lib/theme.ts";
import { Panel } from "@/shared/ui/panel.tsx";
import { Viewport } from "@/shared/ui/viewport.tsx";
import { truncate } from "@/shared/lib/text.ts";
import { useTick } from "@/shared/hooks/use-tick.ts";
type RowProps = { line: Line };

const Row = ({ line }: RowProps) => {
  return (
    <Text>
      {line.map((seg, i) => (
        <Text
          key={i}
          {...(seg.color ? { color: seg.color } : {})}
          {...(seg.dim ? { dimColor: true } : {})}
          {...(seg.bold ? { bold: true } : {})}
          {...(seg.inverse ? { inverse: true } : {})}
        >
          {seg.t}
        </Text>
      ))}
    </Text>
  );
};

const fitKeys = (keys: [string, string][], width: number): [string, string][] => {
  const size = (ks: [string, string][]) =>
    ks.reduce((n, [k, l], i) => n + (i ? 3 : 0) + k.length + l.length + 1, 1);
  const out = [...keys];
  for (const drop of ["r", "c", "i", "?"])
    if (size(out) > width) {
      const at = out.findIndex(([k]) => k === drop);
      if (at >= 0) out.splice(at, 1);
    }
  return out;
};

export const progressOf = (items: FindingView[]) => {
  const live = items.filter((i) => triage(i) !== "applied");
  const reviewed = live.filter((i) => triage(i) !== "pending").length;
  const accepted = items.filter((i) => triage(i) === "accepted").length;
  const applicable = items.filter(
    (i) => i.finding.selected && i.finding.status === "open" && i.fix,
  ).length;
  return { total: live.length, reviewed, accepted, applicable };
};
type StreamViewProps = {
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
  idle: boolean;
  canRerun?: boolean;
  canGoBack?: boolean;
  seenCount?: number;
};

export const StreamView = (props: StreamViewProps) => {
  const { state, items, width, height } = props;
  const review = state.review;
  const current = items[Math.min(props.cursor, Math.max(0, items.length - 1))];
  const all = state.items.filter(
    (findingView) =>
      !(findingView.finding.verdict === "rejected" || findingView.finding.status === "closed"),
  );
  const p = progressOf(all);
  const filtered = state.items.length - all.length;

  const leftW = Math.min(28, Math.max(20, Math.floor(width / 5)));
  const rightW = width - leftW - 1;
  const panelH = Math.max(5, height - 5);
  const rows = panelH - 2;
  const innerW = rightW - 4;
  const tree = fileTree(state);
  const fileCursor = Math.max(
    0,
    tree.findIndex(
      (treeRow) => treeRow.file !== undefined && treeRow.file === current?.finding.file,
    ),
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
        width: innerW - 1,
        drafting,
        ...(spin ? { spin } : {}),
      }),
    [items, state, current?.finding.id, props.expanded, props.fixTab, innerW, drafting, spin],
  );
  const span = current ? stream.card.get(current.finding.id) : undefined;
  const lines = stream.rows.map((streamRow, i) => <Row key={i} line={streamRow.line} />);
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
            ["c", "comment on PR"],
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
          {tree.slice(fstart, fstart + rows - 1).map((treeRow, k) => {
            const i = fstart + k;
            const here = treeRow.file !== undefined && treeRow.file === current?.finding.file;
            return (
              <Text
                key={treeRow.key}
                wrap="truncate"
                {...(props.focus === "files" && i === fileCursor ? { inverse: true } : {})}
                {...(here ? { color: T.cyan } : {})}
              >
                {truncate(treeRow.label, leftW - 9).padEnd(leftW - 8)}
                {String(treeRow.count).padStart(3)}
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
};
