import { Box, Text } from "ink";
import { type ReactNode } from "react";
import { parseUnifiedDiff } from "@crit/core";

export const diffRows = (patch: string): ReactNode[] => {
  const rows: { n: string; sign: string; text: string }[] = [];
  for (const file of parseUnifiedDiff(patch)) {
    for (const parsedHunk of file.hunks) {
      let n = parsedHunk.newStart;
      for (const l of parsedHunk.body) {
        const sign = l[0] ?? " ";
        if (sign === "\\") continue;
        const text = l.slice(1);
        if (sign === "-") rows.push({ n: String(n), sign: "-", text });
        else {
          rows.push({ n: String(n), sign: sign === "+" ? "+" : " ", text });
          n++;
        }
      }
    }
  }
  const width = Math.max(3, ...rows.map((row) => row.n.length));
  return rows.map((row, i) => (
    <Text
      key={i}
      {...(row.sign === "+"
        ? { color: "#86efac" }
        : row.sign === "-"
          ? { color: "#f87171" }
          : { dimColor: true })}
    >
      {`   ${row.n.padStart(width)}  ${row.sign} ${row.text}`}
    </Text>
  ));
};
type Props = { patch: string; maxLines?: number };

export const DiffView = ({ patch, maxLines = 30 }: Props) => {
  const rows: { n: string; sign: string; text: string }[] = [];
  for (const file of parseUnifiedDiff(patch)) {
    for (const parsedHunk of file.hunks) {
      let n = parsedHunk.newStart;
      for (const l of parsedHunk.body) {
        const sign = l[0] ?? " ";
        if (sign === "\\") continue;
        const text = l.slice(1);
        if (sign === "-") rows.push({ n: String(n), sign: "-", text });
        else {
          rows.push({ n: String(n), sign: sign === "+" ? "+" : " ", text });
          n++;
        }
      }
    }
  }
  const shown = rows.slice(0, maxLines);
  const width = Math.max(3, ...shown.map((r) => r.n.length));
  return (
    <Box flexDirection="column">
      {shown.map((r, i) => (
        <Text
          key={i}
          {...(r.sign === "+" ? { color: "green" } : r.sign === "-" ? { color: "red" } : {})}
        >
          {`   ${r.n.padStart(width)}  ${r.sign} ${r.text}`}
        </Text>
      ))}
      {rows.length > shown.length ? (
        <Text dimColor> … {rows.length - shown.length} more lines</Text>
      ) : null}
    </Box>
  );
};
