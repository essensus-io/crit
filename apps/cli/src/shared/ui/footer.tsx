import { Box, Text } from "ink";
import { HRule } from "./hrule.tsx";
type Props = { keys: [string, string][]; width: number };

export const Footer = ({ keys, width }: Props) => {
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
};
