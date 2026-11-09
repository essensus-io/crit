import { Text } from "ink";
type Props = { width: number; char?: string };

export const HRule = ({ width, char = "─" }: Props) => {
  return <Text dimColor>{char.repeat(Math.max(1, width))}</Text>;
};
