import { setRole } from "@crit/providers";
import { Role } from "@crit/schema";
import { saveProviders } from "@crit/store";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { CliError, EXIT } from "@/shared/lib/errors.ts";
import { load } from "./providers-file.ts";

export async function setRoleCmd(
  ctx: CliContext,
  role: string,
  name: string | undefined,
): Promise<number> {
  if (!Role.safeParse(role).success)
    throw new CliError(`crit: unknown role ${role}`, { exitCode: EXIT.usage });
  saveProviders(ctx.paths, setRole(load(ctx), role as Role, name ?? null));
  ctx.out(name ? `${role} → ${name}\n` : `Cleared role ${role}\n`);
  return EXIT.ok;
}
