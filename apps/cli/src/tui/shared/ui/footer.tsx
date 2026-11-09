import { Box, Text } from "ink";
import { HRule } from "./hrule.tsx";

/** Key hints at the bottom: "j/k move · space select · …" */
export function Footer({ keys, width }: { keys: [string, string][]; width: number }) {
  return (
    <Box flexDirection="column">
      <HRule width={width} />
      <Text wrap="truncate">
        {" "}
        {keys.map(([k, label], i) => (
          <Text key={k}>
            {i > 0 ? <Text dimColor> · </Text> : null}
            <Text bold>{k}</Text> {label}
          </Text>
        ))}
      </Text>
    </Box>
  );
}
