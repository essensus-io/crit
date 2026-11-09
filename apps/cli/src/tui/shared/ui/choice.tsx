import { Text, useInput } from "ink";

/** A one-key choice line, e.g. "Dismiss: f false positive · w won't fix · l later · esc cancel". */
export function Choice({
  label,
  options,
  onPick,
  onCancel,
  enterPicksFirst = false,
}: {
  label: string;
  options: [string, string][];
  onPick: (key: string) => void;
  onCancel: () => void;
  /** Enter takes the first option, which is then marked. */
  enterPicksFirst?: boolean;
}) {
  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.return && enterPicksFirst && options[0]) return onPick(options[0][0]);
    if (options.some(([k]) => k === input)) onPick(input);
  });
  return (
    <Text>
      {" "}
      <Text bold>{label}</Text>{" "}
      {options.map(([k, l], i) => (
        <Text key={k}>
          {i > 0 ? " · " : ""}
          <Text bold color="cyan">
            {k}
          </Text>{" "}
          {l}
          {enterPicksFirst && i === 0 ? <Text dimColor> (enter)</Text> : null}
        </Text>
      ))}
      <Text dimColor> · esc cancel</Text>
    </Text>
  );
}
