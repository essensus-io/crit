import { Box, Text, useInput } from "ink";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { T } from "../lib/index.ts";

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
  arrows = true,
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
  /** ↑/↓ scroll a line. Off when the screen uses them for something else. */
  arrows?: boolean;
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
      if ((arrows && key.upArrow) || (vim && input === "k")) return move(shown - 1);
      if ((arrows && key.downArrow) || (vim && input === "j")) return move(shown + 1);
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
