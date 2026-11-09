import { Text } from "ink";

export function HRule({ width, char = "─" }: { width: number; char?: string }) {
  return <Text dimColor>{char.repeat(Math.max(1, width))}</Text>;
}
