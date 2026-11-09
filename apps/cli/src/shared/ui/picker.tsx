import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { T } from "@/shared/lib/theme.ts";
import { Panel } from "./panel.tsx";

export type PickOption<V> = { value: V; label: string; hint?: string };
type Props<V> = {
  title: string;
  options: PickOption<V>[];
  initial?: V;
  width: number;
  height: number;
  note?: string;
  onPick: (value: V) => void;
  onCancel: () => void;
};

export const Picker = <V,>({
  title,
  options,
  initial,
  width,
  height,
  note,
  onPick,
  onCancel,
}: Props<V>) => {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      options.findIndex((o) => o.value === initial),
    ),
  );
  const q = query.toLowerCase();
  const list = q
    ? options.filter((o) => `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(q))
    : options;
  const cur = Math.min(index, Math.max(0, list.length - 1));
  const rows = Math.max(3, height - 7);
  const start = Math.max(0, Math.min(cur - Math.floor(rows / 2), list.length - rows));
  const w = Math.min(width - 2, 90);

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.return) return void (list[cur] && onPick(list[cur]!.value));
    if (key.upArrow || (key.ctrl && input === "p")) return setIndex(Math.max(0, cur - 1));
    if (key.downArrow || (key.ctrl && input === "n"))
      return setIndex(Math.min(list.length - 1, cur + 1));
    if (key.pageUp) return setIndex(Math.max(0, cur - rows));
    if (key.pageDown) return setIndex(Math.min(list.length - 1, cur + rows));
    if (key.backspace || key.delete) {
      setQuery((s) => s.slice(0, -1));
      return setIndex(0);
    }
    if (key.ctrl || key.meta || key.tab || key.leftArrow || key.rightArrow) return;
    if (input) {
      setQuery((s) => s + input);
      setIndex(0);
    }
  });

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Panel title={title} tone="lav" width={w} height={rows + 5}>
        <Text>
          <Text color={T.lav}>search ›</Text> <Text>{query}</Text>
          <Text inverse> </Text>
          <Text dimColor>
            {" "}
            {list.length} of {options.length}
          </Text>
        </Text>
        <Text> </Text>
        {list.length === 0 ? <Text dimColor>No matches.</Text> : null}
        {list.slice(start, start + rows).map((o, i) => {
          const idx = start + i;
          return (
            <Text key={`${idx}`} wrap="truncate" {...(idx === cur ? { inverse: true } : {})}>
              {idx === cur ? "› " : "  "}
              {o.label}
              {o.hint ? <Text dimColor> {o.hint}</Text> : null}
            </Text>
          );
        })}
      </Panel>
      <Text dimColor>
        {" "}
        {note ? `${note} · ` : ""}type to search · ↑/↓ move · enter pick · esc cancel
      </Text>
    </Box>
  );
};
