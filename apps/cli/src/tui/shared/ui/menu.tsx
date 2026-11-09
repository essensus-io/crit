import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { T } from "../lib/index.ts";
import { Panel } from "./panel.tsx";

export type MenuItem = { key: string; label: string; hint?: string };
type Props = {
  title: string;
  items: MenuItem[];
  width: number;
  height: number;
  note?: string;
  onPick: (key: string) => void;
  onCancel: () => void;
};

export const Menu = ({ title, items, width, height, note, onPick, onCancel }: Props) => {
  const [index, setIndex] = useState(0);
  useInput((input, key) => {
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
};
