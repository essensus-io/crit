import type { CliContext } from "@/shared/lib/cli-context.ts";
import { CliError, EXIT } from "@/shared/lib/errors.ts";
import { testProvider } from "@/features/provider-setup/lib/test-provider.ts";
import { colors } from "@/shared/lib/colors.ts";
import { duration } from "@/shared/lib/format.ts";
import { load, need } from "./providers-file.ts";

export async function testProviders(ctx: CliContext, name?: string): Promise<number> {
  const file = load(ctx);
  const list = name ? [need(file, name)] : file.providers.filter((provider) => provider.enabled);
  if (list.length === 0)
    throw new CliError("crit: no providers to test", {
      hint: "Add one with `crit providers add`.",
    });
  const c = colors(ctx.color);
  let failed = 0;
  for (const p of list) {
    const testResult = await testProvider(ctx, p);
    if (testResult.ok)
      ctx.out(`${c.green("✓")} ${p.name.padEnd(12)} replied in ${duration(testResult.ms)}\n`);
    else {
      failed++;
      ctx.out(`${c.red("✗")} ${p.name.padEnd(12)} ${testResult.error}\n`);
    }
  }
  return failed ? EXIT.error : EXIT.ok;
}
