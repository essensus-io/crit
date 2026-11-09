import { Text } from "ink";
import { SPINNER, T, type Tone } from "../lib/index.ts";
import { useTick } from "../hooks/index.ts";

export function Spinner({ tone = "orange", active = true }: { tone?: Tone; active?: boolean }) {
  const n = useTick(120, active);
  return <Text color={T[tone]}>[{active ? SPINNER[n % SPINNER.length] : " "}]</Text>;
}
