import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { CliError, EXIT } from "@/shared/lib/errors.ts";

export async function importCursorRules(ctx: CliContext, text?: string): Promise<number> {
  let body = text;
  if (body === undefined) {
    if (!ctx.interactive)
      throw new CliError("crit: pass the rules text with --text, or run in a terminal", {
        exitCode: EXIT.usage,
      });
    ctx.prompter.info(
      "Open Cursor → Settings → Rules, copy your User Rules, and paste them below.",
    );
    body = await ctx.prompter.text({
      message: "Cursor user rules",
      validate: (v) => (v.trim() ? undefined : "paste at least one rule"),
    });
  }
  const dest = join(ctx.paths.config, "rules", "cursor-user-rules.md");
  mkdirSync(join(ctx.paths.config, "rules"), { recursive: true });
  writeFileSync(dest, `---\ntitle: Cursor user rules\n---\n${body.trim()}\n`);
  ctx.out(`Saved ${dest}\n`);
  return EXIT.ok;
}
