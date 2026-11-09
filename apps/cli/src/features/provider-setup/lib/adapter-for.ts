import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type ProviderAdapter } from "@crit/providers";
import { type ProviderProfile } from "@crit/schema";
import type { CliContext } from "@/shared/lib/cli-context.ts";

export function adapterFor(ctx: CliContext, profile: ProviderProfile): ProviderAdapter {
  const tmpDir = join(ctx.paths.cache, "runs");
  mkdirSync(tmpDir, { recursive: true });
  return ctx.registry.create(profile, { env: ctx.env, tmpDir });
}
