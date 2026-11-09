import { Box, Text } from "ink";
import { type ReactNode } from "react";
import { DASH, T, type Tone } from "../lib/index.ts";
import { truncate } from "../lib/index.ts";

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
