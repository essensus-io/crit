import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { T } from "../lib/index.ts";
import { Panel } from "./panel.tsx";

export type MenuItem = { key: string; label: string; hint?: string };

/**
 * A short list where each row has its own letter: press it, or move with the
 * arrows and press enter. Used for the actions and options menus.
 */
export function Menu({
  title,
  items,
  width,
  height,
  note,
  onPick,
  onCancel,
}: {
  title: string;
  items: MenuItem[];
  width: number;
  height: number;
  note?: string;
  onPick: (key: string) => void;
  onCancel: () => void;
}) {
  const [index, setIndex] = useState(0);
  useInput((input, key) => {
    // Letters belong to the rows, so only arrows move.
    if (key.escape) return onCancel();
    if (key.return) return void (items[index] && onPick(items[index]!.key));
    if (key.upArrow) return setIndex((i) => Math.max(0, i - 1));
    if (key.downArrow) return setIndex((i) => Math.min(items.length - 1, i + 1));
    const hit = items.find((i) => i.key === input);
    if (hit) onPick(hit.key);
  });
  const w = Math.min(width - 2, 74);
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Panel title={title} tone="lav" width={w} height={items.length + 3}>
        {items.map((it, i) => (
          <Text key={it.key} wrap="truncate" {...(i === index ? { inverse: true } : {})}>
            {i === index ? "› " : "  "}
            <Text bold color={T.cyan}>{`${it.key}`}</Text>
            {`  ${it.label}`}
            {it.hint ? <Text dimColor>{`  ${it.hint}`}</Text> : null}
          </Text>
        ))}
      </Panel>
      <Text dimColor> {note ? `${note} · ` : ""}press a letter · ↑/↓ + enter · esc close</Text>
    </Box>
  );
}
