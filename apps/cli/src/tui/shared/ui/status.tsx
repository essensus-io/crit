import { Text } from "ink";

export function Status({
  busy,
  notice,
  error,
}: {
  busy?: string | undefined;
  notice?: string | undefined;
  error?: string | undefined;
}) {
  if (busy) return <Text color="cyan"> ◐ {busy}</Text>;
  if (error) return <Text color="red"> ✗ {error}</Text>;
  if (notice) return <Text color="green"> {notice}</Text>;
  return null;
}
