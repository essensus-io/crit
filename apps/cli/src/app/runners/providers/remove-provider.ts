import { removeProfile, rolesOf } from "@crit/providers";
import { saveProviders } from "@crit/store";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { CliError, EXIT } from "@/shared/lib/errors.ts";
import { load, need } from "./providers-file.ts";

export async function removeProviderCmd(
  ctx: CliContext,
  name: string,
  args: { yes?: boolean; default?: string },
): Promise<number> {
  const file = load(ctx);
  need(file, name);
  const isDefault = file.default === name;
  if (!args.yes) {
    if (!ctx.interactive)
      throw new CliError(`crit: pass --yes to remove ${name}`, { exitCode: EXIT.usage });
    const ok = await ctx.prompter.confirm({
      message: isDefault ? `${name} is your default. Remove it?` : `Remove ${name}?`,
      initialValue: false,
    });
    if (!ok) return EXIT.cancelled;
  }
  let newDefault = args.default;
  const rest = file.providers.filter((provider) => provider.name !== name);
  if (isDefault && rest.length > 0 && !newDefault) {
    if (rest.length === 1) newDefault = rest[0]!.name;
    else if (ctx.interactive)
      newDefault = await ctx.prompter.select({
        message: "New default",
        options: rest.map((p) => ({ value: p.name, label: p.name })),
      });
    else
      throw new CliError(
        `crit: ${name} is the default; pass --default <name> to choose a new one`,
        { exitCode: EXIT.usage },
      );
  }
  const roles = rolesOf(file, name);
  saveProviders(ctx.paths, removeProfile(file, name, newDefault));
  ctx.out(
    `Removed ${name}${newDefault && isDefault ? ` · default is now ${newDefault}` : ""}${roles.length ? ` · cleared roles ${roles.join(", ")}` : ""}\n`,
  );
  return EXIT.ok;
}
