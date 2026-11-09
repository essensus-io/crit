import { CliError } from "@/shared/lib/errors.ts";

export function nonInteractiveSetupError(): CliError {
  return new CliError("crit: no providers configured, and this is not an interactive terminal.", {
    hint: "Add one with:\n  crit providers add claude-code --model opus --default",
    exitCode: 1,
  });
}
