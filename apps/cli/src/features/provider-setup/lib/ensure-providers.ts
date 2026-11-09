import { type ProvidersFile } from "@crit/schema";
import { loadProviders } from "@crit/store";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { firstRun } from "./first-run.ts";
import { nonInteractiveSetupError } from "./non-interactive-setup-error.ts";

export async function ensureProviders(ctx: CliContext, continuing: string): Promise<ProvidersFile> {
  const existing = loadProviders(ctx.paths);
  if (existing && existing.providers.length > 0) return existing;
  if (!ctx.interactive) throw nonInteractiveSetupError();
  return firstRun(ctx, continuing);
}
