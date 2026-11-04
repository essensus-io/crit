import { type Lens, SEVERITY_ORDER, type Severity, shortId } from "@crit/schema";
import { Box, Text } from "ink";
import { basename, dirname } from "node:path";
import { Footer, HRule, SEV_COLOR, SEV_LABEL, Status, truncate } from "./components.tsx";
import type { FindingView, SessionState } from "./session.ts";

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
}) {
  const { state, filter, cursor, width } = props;
  const items = visibleItems(state, filter);
  const all = state.items.filter((v) => !hidden(v));
  const selected = all.filter((v) => v.finding.selected).length;
  const filtered = state.items.length - all.length;
  const review = state.review;
  const left = 26;
  const right = Math.max(30, width - left - 3);
  const tree = fileTree(state);
  const rows = Math.max(5, props.height - 8);
  const start = Math.max(0, Math.min(cursor - Math.floor(rows / 2), items.length - rows));
  const sevLabel = filter.severity ? `${filter.severity}+` : "all severities";
  const lensLabel = filter.lens ?? "all lenses";

  return (
    <Box flexDirection="column" width={width}>
      <Text>
        {" "}
        <Text bold>crit · review {shortId(review.id)}</Text> · {review.scopeLabel} ·{" "}
        {review.provider}
        {review.model ? ` (${review.model})` : ""} · {all.length} findings · {selected} selected
      </Text>
      <HRule width={width} />
      <Box>
        <Box flexDirection="column" width={left}>
          <Text dimColor bold={props.focus === "files"}>
            {" "}
            FILES
          </Text>
          {tree.slice(0, rows).map((r, i) => (
            <Text
              key={r.key}
              {...(props.focus === "files" && i === props.fileCursor ? { inverse: true } : {})}
              {...(filter.file === r.file && r.file ? { color: "cyan" } : {})}
            >
              {" "}
              {truncate(r.label, left - 6).padEnd(left - 5)}
              {String(r.count).padStart(3)}
            </Text>
          ))}
          <Text> </Text>
          <Text
            {...(filter.tab === "filtered" ? { color: "cyan", bold: true } : { dimColor: true })}
          >
            {" "}
            Filtered ({filtered})
          </Text>
        </Box>
        <Box flexDirection="column" width={1}>
          {Array.from(
            { length: Math.min(rows, Math.max(tree.length, items.length) + 2) },
            (_, i) => (
              <Text key={i} dimColor>
                │
              </Text>
            ),
          )}
        </Box>
        <Box flexDirection="column" width={right} paddingLeft={1}>
          <Text>
            <Text dimColor bold={props.focus === "findings"}>
              {filter.tab === "filtered" ? "FILTERED BY SKEPTIC / DISMISSED" : "FINDINGS"}
            </Text>
            <Text dimColor>
              {"   "}
              {sevLabel} · {lensLabel}
              {filter.search ? ` · /${filter.search}` : ""}
            </Text>
          </Text>
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
                {...(props.focus === "findings" && idx === cursor ? { inverse: true } : {})}
              >
                {box} <Text color={SEV_COLOR[f.severity]}>{SEV_LABEL[f.severity].padEnd(4)}</Text>{" "}
                {truncate(loc, 18).padEnd(18)} {truncate(f.title, right - 32)}
                <Text dimColor>{tag}</Text>
              </Text>
            );
          })}
          {items.length > rows ? (
            <Text dimColor> {items.length - rows} more · j/k to scroll</Text>
          ) : null}
        </Box>
      </Box>
      <Status busy={state.busy} notice={state.notice} error={state.error} />
      {props.prompt ?? null}
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
          ["tab", "filtered"],
          ["q", "quit"],
        ]}
      />
    </Box>
  );
}
