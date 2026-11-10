import { listModels } from "@crit/providers";
import { loadProviders } from "@crit/store";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { CliError, EXIT } from "@/shared/lib/errors.ts";
import { colors } from "@/shared/lib/colors.ts";
import { table } from "@/shared/lib/table.ts";

export async function listProviderModels(
  ctx: CliContext,
  target: string | undefined,
  args: { search?: string; json?: boolean },
): Promise<number> {
  const file = loadProviders(ctx.paths);
  const profile = target ? file?.providers.find((provider) => provider.name === target) : undefined;
  const byDefault = !target
    ? file?.providers.find((provider) => provider.name === file.default)
    : undefined;
  const chosen = profile ?? byDefault;
  const factory = ctx.registry.get(chosen?.type ?? target ?? "");
  if (!factory)
    throw new CliError(`crit: ${target ?? "no provider"} is not a provider name or type`, {
      hint: `Providers: ${file?.providers.map((provider) => provider.name).join(", ") || "none"}. Types: ${ctx.registry
        .list()
        .map((adapterFactory) => adapterFactory.type)
        .join(", ")}.`,
    });
  const command = chosen?.command ?? factory.defaultCommand;
  const { models, live } = await listModels(factory, { command, env: ctx.env });
  const q = args.search?.toLowerCase();
  const shown = q
    ? models.filter(
        (modelInfo) =>
          modelInfo.id.toLowerCase().includes(q) || modelInfo.label.toLowerCase().includes(q),
      )
    : models;
  if (args.json) {
    ctx.out(
      `${JSON.stringify({ provider: chosen?.name ?? null, type: factory.type, live, current: chosen?.model ?? null, models: shown }, null, 2)}\n`,
    );
    return EXIT.ok;
  }
  const c = colors(ctx.color);
  const rows = [["", c.dim("MODEL ID"), c.dim("NAME"), c.dim("EFFORTS")]];
  for (const modelInfo of shown)
    rows.push([
      modelInfo.id === chosen?.model ? "●" : " ",
      modelInfo.id,
      modelInfo.label,
      modelInfo.efforts?.length
        ? `${modelInfo.efforts.join(" ")}${modelInfo.defaultEffort ? c.dim(` (default ${modelInfo.defaultEffort})`) : ""}`
        : factory.efforts.length
          ? c.dim("per CLI")
          : c.dim("in the model id"),
    ]);
  ctx.out(`\n${table(rows)}\n\n`);
  ctx.out(
    `  ${c.dim(`${shown.length}${q ? ` of ${models.length}` : ""} models${live ? "" : " (built-in list; the CLI did not list its own)"} · crit providers edit ${chosen?.name ?? "<name>"} --model <id>`)}\n\n`,
  );
  return EXIT.ok;
}
