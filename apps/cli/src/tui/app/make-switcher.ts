import { type ResolvedConfig } from "@crit/schema";
import { loadProviders } from "@crit/store";
import { type CliContext } from "../../context.ts";
import { type Choice, createSwitcher, type Switcher } from "../features/model-switching/index.ts";

export function makeSwitcher(
  ctx: CliContext,
  config: ResolvedConfig,
  initial: Partial<Choice> & { provider: string },
): Switcher | undefined {
  const file = loadProviders(ctx.paths);
  if (!file?.providers.length) return undefined;
  return createSwitcher(ctx, file, config, initial);
}
