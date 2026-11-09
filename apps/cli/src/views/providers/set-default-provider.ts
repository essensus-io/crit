import { setDefault } from "@crit/providers";
import { saveProviders } from "@crit/store";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { EXIT } from "@/shared/lib/errors.ts";
import { load } from "./providers-file.ts";

export async function setDefaultCmd(ctx: CliContext, name: string): Promise<number> {
  saveProviders(ctx.paths, setDefault(load(ctx), name));
  ctx.out(`Default provider: ${name}\n`);
  return EXIT.ok;
}
