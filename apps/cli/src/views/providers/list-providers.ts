import { Role } from "@crit/schema";
import { loadProviders } from "@crit/store";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { EXIT } from "@/shared/lib/errors.ts";
import { colors } from "@/shared/lib/colors.ts";
import { table } from "@/shared/lib/table.ts";

export async function listProviders(ctx: CliContext): Promise<number> {
  const file = loadProviders(ctx.paths);
  const c = colors(ctx.color);
  if (!file || file.providers.length === 0) {
    ctx.out("No providers yet. Run `crit providers add` (or any crit command) to set one up.\n");
    return EXIT.ok;
  }
  const rows: string[][] = [[c.dim("  NAME"), c.dim("TYPE"), c.dim("MODEL"), c.dim("STATUS"), ""]];
  for (const p of file.providers) {
    let status = "disabled";
    if (p.enabled) {
      const factory = ctx.registry.get(p.type);
      if (!factory) status = c.red(`unknown type ${p.type}`);
      else {
        const d = await ctx.registry.create(p, { env: ctx.env, tmpDir: ctx.paths.cache }).detect();
        status = !d.installed
          ? c.red("not installed")
          : d.untestedVersion
            ? c.yellow(`ready (${d.version}, untested)`)
            : c.green(d.version ? `ready (${d.version})` : "ready");
      }
    }
    rows.push([
      `${file.default === p.name ? "●" : " "} ${p.name}`,
      p.type,
      p.model ?? "CLI default",
      status,
      file.default === p.name ? "default" : "",
    ]);
  }
  ctx.out(`\n${table(rows)}\n`);
  const roles = (["review", "skeptic", "evaluate"] as Role[]).map(
    (r) =>
      `${r} → ${file.roles[r] ?? (r === "review" ? file.default : (file.roles.review ?? file.default)) ?? "-"}`,
  );
  ctx.out(`\n  ${c.dim("roles")}   ${roles.join(" · ")}\n\n`);
  return EXIT.ok;
}
