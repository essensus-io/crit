import { Box, Text, useInput } from "ink";
import { type ReactNode, useRef, useState } from "react";
import { parseUnifiedDiff } from "@crit/core";

export { SEV_COLOR, SEV_LABEL } from "./theme.ts";

export function HRule({ width, char = "─" }: { width: number; char?: string }) {
  return <Text dimColor>{char.repeat(Math.max(1, width))}</Text>;
}

/** Key hints at the bottom: "j/k move · space select · …" */
export function Footer({ keys, width }: { keys: [string, string][]; width: number }) {
  return (
    <Box flexDirection="column">
      <HRule width={width} />
      <Text wrap="truncate">
        {" "}
        {keys.map(([k, label], i) => (
          <Text key={k}>
            {i > 0 ? <Text dimColor> · </Text> : null}
            <Text bold>{k}</Text> {label}
          </Text>
        ))}
      </Text>
    </Box>
  );
}

export function Status({
  busy,
  notice,
  error,
}: {
  busy?: string | undefined;
  notice?: string | undefined;
  error?: string | undefined;
}) {
  if (busy) return <Text color="cyan"> ◐ {busy}</Text>;
  if (error) return <Text color="red"> ✗ {error}</Text>;
  if (notice) return <Text color="green"> {notice}</Text>;
  return null;
}

/** A diff as one colored row per line, for a scrolling Viewport. */
export function diffRows(patch: string): ReactNode[] {
  const rows: { n: string; sign: string; text: string }[] = [];
  for (const file of parseUnifiedDiff(patch)) {
    for (const h of file.hunks) {
      let n = h.newStart;
      for (const l of h.body) {
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
  const width = Math.max(3, ...rows.map((r) => r.n.length));
  return rows.map((r, i) => (
    <Text
      key={i}
      {...(r.sign === "+"
        ? { color: "#86efac" }
        : r.sign === "-"
          ? { color: "#f87171" }
          : { dimColor: true })}
    >
      {`   ${r.n.padStart(width)}  ${r.sign} ${r.text}`}
    </Text>
  ));
}

/** A unified diff with new-side line numbers, + green and - red, as in the finding detail mockup. */
export function DiffView({ patch, maxLines = 30 }: { patch: string; maxLines?: number }) {
  const rows: { n: string; sign: string; text: string }[] = [];
  for (const file of parseUnifiedDiff(patch)) {
    for (const h of file.hunks) {
      let n = h.newStart;
      for (const l of h.body) {
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
}

/** One-line text input: type, backspace, enter submits, esc cancels. */
export function TextInput({
  label,
  onSubmit,
  onCancel,
  initial = "",
}: {
  label: string;
  onSubmit: (v: string) => void;
  onCancel: () => void;
  initial?: string;
}) {
  const [value, setValue] = useState(initial);
  // Keys can arrive faster than renders (pastes); keep the latest value in a ref.
  const ref = useRef(initial);
  const update = (v: string) => {
    ref.current = v;
    setValue(v);
  };
  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.return) return onSubmit(ref.current);
    if (key.backspace || key.delete) return update(ref.current.slice(0, -1));
    if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow) return;
    if (input) update(ref.current + input);
  });
  return (
    <Text>
      {" "}
      {label} <Text color="cyan">{value}</Text>
      <Text inverse> </Text>
    </Text>
  );
}

/** A one-key choice line, e.g. "Dismiss: f false positive · w won't fix · l later · esc cancel". */
export function Choice({
  label,
  options,
  onPick,
  onCancel,
  enterPicksFirst = false,
}: {
  label: string;
  options: [string, string][];
  onPick: (key: string) => void;
  onCancel: () => void;
  /** Enter takes the first option, which is then marked. */
  enterPicksFirst?: boolean;
}) {
  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.return && enterPicksFirst && options[0]) return onPick(options[0][0]);
    if (options.some(([k]) => k === input)) onPick(input);
  });
  return (
    <Text>
      {" "}
      <Text bold>{label}</Text>{" "}
      {options.map(([k, l], i) => (
        <Text key={k}>
          {i > 0 ? " · " : ""}
          <Text bold color="cyan">
            {k}
          </Text>{" "}
          {l}
          {enterPicksFirst && i === 0 ? <Text dimColor> (enter)</Text> : null}
        </Text>
      ))}
      <Text dimColor> · esc cancel</Text>
    </Text>
  );
}

export const truncate = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
