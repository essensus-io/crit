import { Text, useInput } from "ink";
import { useRef, useState } from "react";
type Props = {
  label: string;
  onSubmit: (v: string) => void;
  onCancel: () => void;
  initial?: string;
};

/** One-line text input: type, backspace, enter submits, esc cancels. */
export const TextInput = ({ label, onSubmit, onCancel, initial = "" }: Props) => {
  const [value, setValue] = useState(initial);
  // Keys can arrive faster than renders (pastes); keep the latest value in a ref.
  const ref = useRef(initial);
  const update = (v: string) => {
    ref.current = v;
    setValue(v);
  };
  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.return) return onSubmit(ref.current);
    if (key.backspace || key.delete) return update(ref.current.slice(0, -1));
    if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow) return;
    if (input) update(ref.current + input);
  });
  return (
    <Text>
      {" "}
      {label} <Text color="cyan">{value}</Text>
      <Text inverse> </Text>
    </Text>
  );
};
