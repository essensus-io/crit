import { type AdapterFactory } from "@crit/providers";
import { type ProviderProfile, ProviderName, type ProvidersFile } from "@crit/schema";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { askEffort, askFastModel, askModel } from "./model-picker.ts";

const validateName = (file: ProvidersFile, except?: string) => (v: string) => {
  const r = ProviderName.safeParse(v.trim());
  if (!r.success) return r.error.issues[0]!.message;
  if (v.trim() !== except && file.providers.some((p) => p.name === v.trim()))
    return `${v.trim()} already exists`;
  return undefined;
};

export async function profilePrompts(
  ctx: CliContext,
  file: ProvidersFile,
  factory: AdapterFactory,
  existing?: ProviderProfile,
  command: string = existing?.command ?? factory.defaultCommand,
): Promise<{
  name: string;
  model: string | null;
  effort: string | null;
  fastModel: string | null;
}> {
  const suggested =
    existing?.name ??
    (file.providers.some((p) => p.name === factory.defaultName)
      ? `${factory.defaultName}-2`
      : factory.defaultName);
  const name = (
    await ctx.prompter.text({
      message: `Name for ${factory.label}`,
      initialValue: suggested,
      validate: validateName(file, existing?.name),
    })
  ).trim();
  const picked = await askModel(ctx, factory, {
    label: factory.label,
    command,
    current: existing?.model ?? null,
  });
  const effort = await askEffort(ctx, factory, {
    label: factory.label,
    info: picked.info,
    current: existing?.effort,
  });
  const fastModel = await askFastModel(ctx, {
    label: factory.label,
    command,
    current: existing?.fastModel,
    models: picked.models,
  });
  return { name, model: picked.model, effort, fastModel };
}
