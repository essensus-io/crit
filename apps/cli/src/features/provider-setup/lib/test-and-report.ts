import { type ProviderProfile } from "@crit/schema";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { colors } from "@/shared/lib/colors.ts";
import { duration } from "@/shared/lib/format.ts";
import { testProvider } from "./test-provider.ts";

export async function testAndReport(ctx: CliContext, profiles: ProviderProfile[]): Promise<void> {
  const c = colors(false);
  const s = ctx.prompter.spinner();
  s.start("Testing providers");
  const lines: string[] = [];
  let failed = false;
  for (const p of profiles) {
    const r = await testProvider(ctx, p);
    if (r.ok) lines.push(`✓ ${p.name.padEnd(10)} replied in ${duration(r.ms)}`);
    else {
      failed = true;
      lines.push(`✗ ${p.name.padEnd(10)} ${r.error}`);
    }
  }
  s.stop(`Testing providers\n${lines.map((l) => c.dim(l)).join("\n")}`, failed);
}
