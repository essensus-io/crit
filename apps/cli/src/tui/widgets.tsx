import { Box, Text, useInput } from "ink";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { DASH, SPINNER, T, type Tone } from "./theme.ts";

export const truncate = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;

/** Word-wrap plain text to `width` columns; words longer than a line are split. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(10, width);
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para.trim() === "") {
      out.push("");
      continue;
    }
    const indent = /^\s*/.exec(para)![0];
    let line = "";
    for (let word of para.trim().split(/\s+/)) {
      while (word.length > w) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(indent + word.slice(0, w - indent.length));
        word = word.slice(w - indent.length);
      }
      if (!line) line = indent + word;
      else if (line.length + 1 + word.length <= w) line += ` ${word}`;
      else {
        out.push(line);
        line = indent + word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/** Re-render every `ms` while `active`, for spinners and flowing connectors. */
export function useTick(ms = 150, active = true): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms, active]);
  return n;
}

export function Spinner({ tone = "orange", active = true }: { tone?: Tone; active?: boolean }) {
  const n = useTick(120, active);
  return <Text color={T[tone]}>[{active ? SPINNER[n % SPINNER.length] : " "}]</Text>;
}

/**
 * A dashed panel with its title in the top border, like the reference
 * dashboard. `width` must be given; `height` (when set) includes the border.
 */
export function Panel({
  title,
  tone = "mint",
  width,
  height,
  children,
}: {
  title?: string;
  tone?: Tone;
  width: number;
  height?: number;
  children?: ReactNode;
}) {
  const color = T[tone];
  const label = title ? ` ${truncate(title, Math.max(1, width - 6))} ` : "";
  const head = `${DASH.topLeft}${DASH.top}${label}${DASH.top.repeat(Math.max(0, width - 3 - label.length))}${DASH.topRight}`;
  return (
    <Box flexDirection="column" width={width} {...(height ? { height } : {})}>
      <Text color={color}>{head}</Text>
      <Box
        borderStyle={DASH}
        borderTop={false}
        borderColor={color}
        width={width}
        paddingX={1}
        flexDirection="column"
        overflow="hidden"
        {...(height ? { height: height - 1 } : {})}
      >
        {children}
      </Box>
    </Box>
  );
}

/** A hatched progress bar: solid for done, a half-tone edge, light for the rest. */
export function Bar({
  value,
  max,
  width,
  tone,
}: {
  value: number;
  max: number;
  width: number;
  tone?: Tone;
}) {
  const w = Math.max(4, width);
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  const filled = Math.floor(w * ratio);
  const edge = filled < w && w * ratio - filled > 0.25 ? 1 : 0;
  const color = T[tone ?? (ratio > 0.9 ? "red" : ratio > 0.6 ? "orange" : "mint")];
  return (
    <Text>
      <Text color={color}>{"█".repeat(filled)}</Text>
      <Text color={color}>{"▒".repeat(edge)}</Text>
      <Text dimColor>{"░".repeat(w - filled - edge)}</Text>
    </Text>
  );
}

/** `[key: value] [key: value]` on one line, clipped to the width. */
export function StatusBar({
  items,
  width,
}: {
  items: { k: string; v: string; tone?: Tone }[];
  width: number;
}) {
  let used = 0;
  const shown: typeof items = [];
  for (const it of items) {
    const len = it.k.length + it.v.length + 5;
    if (used + len > width) break;
    used += len;
    shown.push(it);
  }
  return (
    <Text wrap="truncate">
      {shown.map((it) => (
        <Text key={it.k}>
          <Text dimColor>[{it.k}: </Text>
          <Text color={T[it.tone ?? "lav"]}>{it.v}</Text>
          <Text dimColor>] </Text>
        </Text>
      ))}
    </Text>
  );
}

/**
 * Lines that scroll inside their own box: ↑/↓, j/k, PgUp/PgDn, g/G, Home/End
 * (and the mouse wheel, which terminals send as arrows on the alternate
 * screen). The terminal itself never scrolls. `follow` keeps the bottom in view
 * until the user scrolls up, for logs.
 */
export function Viewport({
  lines,
  height,
  width,
  active = true,
  follow = false,
  resetKey,
  vim = true,
  reveal,
}: {
  lines: ReactNode[];
  height: number;
  width: number;
  active?: boolean;
  follow?: boolean;
  /** Changing this scrolls back to the top (a new finding, a new screen). */
  resetKey?: string;
  /** j/k/g/G scroll too. Off when those keys belong to the screen. */
  vim?: boolean;
  /** When `key` changes, scroll just enough to show rows `from`..`to`. */
  reveal?: { key: string; from: number; to: number };
}) {
  const [offset, setOffset] = useState(0);
  const pinned = useRef(follow);
  const max = Math.max(0, lines.length - height);
  const clamp = (n: number) => Math.min(max, Math.max(0, n));
  const shown = follow && pinned.current ? max : clamp(offset);

  useEffect(() => {
    setOffset(0);
    pinned.current = follow;
  }, [resetKey, follow]);

  useEffect(() => {
    if (!reveal) return;
    pinned.current = false;
    setOffset((cur) => {
      const now = Math.min(max, Math.max(0, cur));
      if (reveal.from >= now && reveal.to < now + height) return now;
      return Math.min(max, Math.max(0, Math.min(reveal.from, reveal.to - height + 1)));
    });
  }, [reveal?.key]);

  useInput(
    (input, key) => {
      const move = (to: number) => {
        const next = clamp(to);
        pinned.current = follow && next >= max;
        setOffset(next);
      };
      if (key.upArrow || (vim && input === "k")) return move(shown - 1);
      if (key.downArrow || (vim && input === "j")) return move(shown + 1);
      if (key.pageUp || (key.ctrl && input === "u")) return move(shown - Math.max(1, height - 1));
      if (key.pageDown || (key.ctrl && input === "d")) return move(shown + Math.max(1, height - 1));
      if (key.home || (vim && input === "g")) return move(0);
      if (key.end || (vim && input === "G")) return move(max);
    },
    { isActive: active && max > 0 },
  );

  const slice = lines.slice(shown, shown + height);
  const thumbSize = Math.max(1, Math.round((height * height) / Math.max(lines.length, 1)));
  const thumbTop = max === 0 ? 0 : Math.round((shown / max) * (height - thumbSize));
  const bar = max > 0;
  return (
    <Box width={width} height={height} overflow="hidden">
      <Box flexDirection="column" width={bar ? width - 1 : width} height={height}>
        {slice.map((l, i) => (
          <Text key={shown + i} wrap="truncate">
            {l}
          </Text>
        ))}
      </Box>
      {bar ? (
        <Box flexDirection="column" width={1} height={height}>
          {Array.from({ length: height }, (_, i) => (
            <Text key={i} color={T.lav} dimColor={!(i >= thumbTop && i < thumbTop + thumbSize)}>
              {i >= thumbTop && i < thumbTop + thumbSize ? "┃" : "│"}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

export type PickOption<V> = { value: V; label: string; hint?: string };

/**
 * A searchable list as a full-screen overlay (model, provider, effort, depth).
 * Type to filter, ↑/↓ to move, enter to pick, esc to cancel.
 */
export function Picker<V>({
  title,
  options,
  initial,
  width,
  height,
  note,
  onPick,
  onCancel,
}: {
  title: string;
  options: PickOption<V>[];
  initial?: V;
  width: number;
  height: number;
  note?: string;
  onPick: (value: V) => void;
  onCancel: () => void;
}) {
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
}

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
