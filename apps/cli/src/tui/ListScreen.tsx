import { type Lens, SEVERITY_ORDER, type Severity, shortId } from "@crit/schema";
import { Box, Text } from "ink";
import { basename, dirname } from "node:path";
import { Footer, Status } from "./components.tsx";
import type { FindingView, SessionState } from "./session.ts";
import { type Choice, describeChoiceParts } from "./switcher.ts";
import { SEV_COLOR, SEV_LABEL, T } from "./theme.ts";
import { Panel, StatusBar, truncate } from "./widgets.tsx";

export type ListFilter = {
  tab: "findings" | "filtered";
  /** Show this severity and above; undefined = all. */
  severity?: Severity;
  lens?: Lens;
  file?: string;
  search?: string;
};

const hidden = (v: FindingView) =>
  v.finding.verdict === "rejected" ||
  v.finding.status === "dismissed" ||
  v.finding.status === "closed";

/** The rows the list shows for the current filter, in display order. */
export function visibleItems(state: SessionState, f: ListFilter): FindingView[] {
  const q = f.search?.toLowerCase();
  return state.items
    .filter((v) => (f.tab === "filtered" ? hidden(v) : !hidden(v)))
    .filter(
      (v) =>
        !f.severity ||
        SEVERITY_ORDER.indexOf(v.finding.severity) <= SEVERITY_ORDER.indexOf(f.severity),
    )
    .filter((v) => !f.lens || v.finding.category === f.lens)
    .filter((v) => !f.file || v.finding.file === f.file)
    .filter(
      (v) =>
        !q || v.finding.title.toLowerCase().includes(q) || v.finding.file.toLowerCase().includes(q),
    )
    .sort(
      (a, b) =>
        a.finding.file.localeCompare(b.finding.file) ||
        SEVERITY_ORDER.indexOf(a.finding.severity) - SEVERITY_ORDER.indexOf(b.finding.severity) ||
        a.finding.range.start - b.finding.range.start,
    );
}

/** Files pane rows: folders with counts, files under them. */
export function fileTree(
  state: SessionState,
): { key: string; label: string; count: number; file?: string }[] {
  const shown = state.items.filter((v) => !hidden(v));
  const byDir = new Map<string, Map<string, number>>();
  for (const v of shown) {
    const d = dirname(v.finding.file);
    const files = byDir.get(d) ?? new Map<string, number>();
    files.set(v.finding.file, (files.get(v.finding.file) ?? 0) + 1);
    byDir.set(d, files);
  }
  const rows: { key: string; label: string; count: number; file?: string }[] = [
    { key: "*", label: "All files", count: shown.length },
  ];
  for (const [d, files] of [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    rows.push({
      key: `d:${d}`,
      label: `▾ ${d === "." ? "(root)" : d}`,
      count: [...files.values()].reduce((a, b) => a + b, 0),
    });
    for (const [file, n] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b)))
      rows.push({ key: file, label: `    ${basename(file)}`, count: n, file });
  }
  return rows;
}

export function ListScreen(props: {
  state: SessionState;
  filter: ListFilter;
  cursor: number;
  fileCursor: number;
  focus: "files" | "findings";
  width: number;
  height: number;
  prompt?: React.ReactNode;
  choice?: Choice;
}) {
  const { state, filter, cursor, width, height } = props;
  const items = visibleItems(state, filter);
  const all = state.items.filter((v) => !hidden(v));
  const selected = all.filter((v) => v.finding.selected).length;
  const filtered = state.items.length - all.length;
  const review = state.review;
  const leftW = Math.min(30, Math.max(22, Math.floor(width / 4)));
  const rightW = width - leftW - 1;
  const tree = fileTree(state);
  // header 1 · panels · status 1 · prompt 1 · footer 2; a panel is border 2 + title row 0
  const panelH = Math.max(5, height - 5);
  const rows = panelH - 2;
  const start = Math.max(0, Math.min(cursor - Math.floor(rows / 2), items.length - rows));
  const fstart = Math.max(
    0,
    Math.min(props.fileCursor - Math.floor((rows - 2) / 2), tree.length - (rows - 2)),
  );
  const sevLabel = filter.severity ? `${filter.severity}+` : "all severities";
  const lensLabel = filter.lens ?? "all lenses";
  const titleW = Math.max(10, rightW - 36);

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
        <Text
          dimColor
        >{` · ${review.provider}${review.model ? ` (${review.model})` : ""} · `}</Text>
        <Text color={T.mint}>{`${all.length} findings`}</Text>
        <Text dimColor> · </Text>
        <Text color={T.orange}>{`${selected} selected`}</Text>
      </Text>
      <Box width={width} height={panelH}>
        <Panel
          title="files"
          tone={props.focus === "files" ? "orange" : "mint"}
          width={leftW}
          height={panelH}
        >
          {tree.slice(fstart, fstart + rows - 2).map((r, k) => {
            const i = fstart + k;
            return (
              <Text
                key={r.key}
                wrap="truncate"
                {...(props.focus === "files" && i === props.fileCursor ? { inverse: true } : {})}
                {...(filter.file === r.file && r.file ? { color: T.cyan } : {})}
              >
                {truncate(r.label, leftW - 9).padEnd(leftW - 8)}
                {String(r.count).padStart(3)}
              </Text>
            );
          })}
          <Text
            {...(filter.tab === "filtered" ? { color: T.cyan, bold: true } : { dimColor: true })}
          >
            {`Filtered (${filtered})`}
          </Text>
        </Panel>
        <Box width={1} />
        <Panel
          title={`${filter.tab === "filtered" ? "filtered by skeptic / dismissed" : "findings"}  ${sevLabel} · ${lensLabel}${filter.search ? ` · /${filter.search}` : ""}`}
          tone={props.focus === "findings" ? "orange" : "mint"}
          width={rightW}
          height={panelH}
        >
          {items.length === 0 ? (
            <Text dimColor>
              {filter.tab === "filtered" ? "Nothing filtered." : "No findings match."}
            </Text>
          ) : null}
          {items.slice(start, start + rows).map((v, i) => {
            const idx = start + i;
            const f = v.finding;
            const loc = `${basename(f.file)}:${f.range.start}`;
            const box =
              filter.tab === "filtered"
                ? f.status === "dismissed"
                  ? "[d]"
                  : "[-]"
                : f.selected
                  ? "[x]"
                  : "[ ]";
            const tag = f.verdict === "plausible" ? " ?" : v.fix?.author === "user" ? " ✎" : "";
            return (
              <Text
                key={f.id}
                wrap="truncate"
                {...(props.focus === "findings" && idx === cursor ? { inverse: true } : {})}
              >
                {box} <Text color={SEV_COLOR[f.severity]}>{SEV_LABEL[f.severity].padEnd(4)}</Text>{" "}
                {truncate(loc, 18).padEnd(18)} {truncate(f.title, titleW)}
                <Text dimColor>{tag}</Text>
              </Text>
            );
          })}
        </Panel>
      </Box>
      {state.busy || state.notice || state.error || !props.choice ? (
        <Status busy={state.busy} notice={state.notice} error={state.error} />
      ) : (
        <StatusBar width={width} items={describeChoiceParts(props.choice)} />
      )}
      {props.prompt ?? <Text> </Text>}
      <Footer
        width={width}
        keys={[
          ["j/k", "move"],
          ["space", "select"],
          ["enter", "open"],
          ["p", "propose"],
          ["d", "dismiss"],
          ["a", `apply ${selected}`],
          ["/", "search"],
          ["s", "severity"],
          ["m", "model"],
          ["P", "provider"],
          ["tab", "filtered"],
          ["q", "quit"],
        ]}
      />
    </Box>
  );
}
