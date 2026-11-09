import { Text } from "ink";
import { SPINNER, T, type Tone } from "../lib/theme.ts";
import { useTick } from "../hooks/use-tick.ts";
type Props = { tone?: Tone; active?: boolean };

export const Spinner = ({ tone = "orange", active = true }: Props) => {
  const n = useTick(120, active);
  return <Text color={T[tone]}>[{active ? SPINNER[n % SPINNER.length] : " "}]</Text>;
};
