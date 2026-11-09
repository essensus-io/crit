import { emptyProvidersFile } from "@crit/providers";
import { type ProvidersFile } from "@crit/schema";
import { loadProviders } from "@crit/store";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { CliError } from "@/shared/lib/errors.ts";

export function load(ctx: CliContext): ProvidersFile {
  return loadProviders(ctx.paths) ?? emptyProvidersFile();
}

export const need = (file: ProvidersFile, name: string) => {
  const p = file.providers.find((x) => x.name === name);
  if (!p)
    throw new CliError(`crit: no provider named "${name}"`, {
      hint: `Have: ${file.providers.map((x) => x.name).join(", ") || "none"}. Add one with \`crit providers add\`.`,
    });
  return p;
};
