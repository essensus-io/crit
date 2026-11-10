import { addProfile, emptyProvidersFile } from "@crit/providers";
import { loadProviders, saveProviders } from "@crit/store";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { CliError, EXIT } from "@/shared/lib/errors.ts";
import { firstRun } from "@/features/provider-setup/lib/first-run.ts";
import { profilePrompts } from "@/features/provider-setup/lib/profile-prompts.ts";
import { testProvider } from "@/features/provider-setup/lib/test-provider.ts";
import { colors } from "@/shared/lib/colors.ts";
import { duration } from "@/shared/lib/format.ts";
import { parseModel } from "./parse-provider-args.ts";

export async function addProvider(
  ctx: CliContext,
  args: {
    type?: string;
    name?: string;
    model?: string;
    effort?: string;
    "fast-model"?: string;
    command?: string;
    default?: boolean;
    test?: boolean;
  },
): Promise<number> {
  const existing = loadProviders(ctx.paths);
  if (!existing && ctx.interactive && !args.type) {
    await firstRun(ctx, "crit providers");
    return EXIT.ok;
  }
  let file = existing ?? emptyProvidersFile();
  const types = ctx.registry.list();
  let type = args.type;
  if (!type) {
    if (!ctx.interactive)
      throw new CliError("crit: pass a provider type", {
        exitCode: EXIT.usage,
        hint: `Types: ${types.map((adapterFactory) => adapterFactory.type).join(", ")}`,
      });
    type = await ctx.prompter.select({
      message: "Provider type",
      options: types.map((adapterFactory) => ({
        value: adapterFactory.type,
        label: `${adapterFactory.label} (${adapterFactory.defaultCommand})`,
      })),
    });
  }
  const factory = ctx.registry.get(type);
  if (!factory)
    throw new CliError(`crit: unknown provider type ${type}`, {
      exitCode: EXIT.usage,
      hint: `Types: ${types.map((adapterFactory) => adapterFactory.type).join(", ")}`,
    });

  let name = args.name;
  let model = parseModel(args.model);
  let effort = parseModel(args.effort);
  let fastModel = parseModel(args["fast-model"]);
  if (
    ctx.interactive &&
    (name === undefined || model === undefined || effort === undefined || fastModel === undefined)
  ) {
    const answers = await profilePrompts(ctx, file, factory, undefined, args.command);
    name ??= answers.name;
    if (model === undefined) model = answers.model;
    if (effort === undefined) effort = answers.effort;
    if (fastModel === undefined) fastModel = answers.fastModel;
  }
  name ??= file.providers.some((provider) => provider.name === factory.defaultName)
    ? `${factory.defaultName}-2`
    : factory.defaultName;
  file = addProfile(
    file,
    {
      name,
      type,
      command: args.command ?? factory.defaultCommand,
      model: model ?? null,
      effort: effort ?? null,
      fastModel: fastModel ?? null,
    },
    { makeDefault: Boolean(args.default) },
  );
  const profile = file.providers.find((provider) => provider.name === name)!;
  if (args.test ?? ctx.interactive) {
    const testResult = await testProvider(ctx, profile);
    if (testResult.ok) ctx.err(`✓ ${name} replied in ${duration(testResult.ms)}\n`);
    else ctx.err(colors(ctx.color).yellow(`✗ ${name} ${testResult.error}\n`));
  }
  saveProviders(ctx.paths, file);
  ctx.out(`Added ${name}${file.default === name ? " (default)" : ""}\n`);
  return EXIT.ok;
}
