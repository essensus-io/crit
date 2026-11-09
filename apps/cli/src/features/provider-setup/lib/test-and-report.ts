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
  for (const profile of profiles) {
    const testResult = await testProvider(ctx, profile);
    if (testResult.ok)
      lines.push(`✓ ${profile.name.padEnd(10)} replied in ${duration(testResult.ms)}`);
    else {
      failed = true;
      lines.push(`✗ ${profile.name.padEnd(10)} ${testResult.error}`);
    }
  }
  s.stop(`Testing providers\n${lines.map((line) => c.dim(line)).join("\n")}`, failed);
}
