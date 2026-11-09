import { Text } from "ink";
import { T, type Tone } from "../lib/index.ts";
type Props = {
  value: number;
  max: number;
  width: number;
  tone?: Tone;
};

/** A hatched progress bar: solid for done, a half-tone edge, light for the rest. */
export const Bar = ({ value, max, width, tone }: Props) => {
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
};
