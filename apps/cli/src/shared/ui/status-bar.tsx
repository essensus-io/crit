import { Text } from "ink";
import { T, type Tone } from "@/shared/lib/theme.ts";
type Props = {
  items: { k: string; v: string; tone?: Tone }[];
  width: number;
};

export const StatusBar = ({ items, width }: Props) => {
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
};
