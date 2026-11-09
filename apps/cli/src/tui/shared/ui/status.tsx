import { Text } from "ink";
type Props = {
  busy?: string | undefined;
  notice?: string | undefined;
  error?: string | undefined;
};

export const Status = ({ busy, notice, error }: Props) => {
  if (busy) return <Text color="cyan"> ◐ {busy}</Text>;
  if (error) return <Text color="red"> ✗ {error}</Text>;
  if (notice) return <Text color="green"> {notice}</Text>;
  return null;
};
