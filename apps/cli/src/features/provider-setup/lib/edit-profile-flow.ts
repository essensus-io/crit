import { type ModelInfo, setRole, updateProfile } from "@crit/providers";
import { type ProviderProfile, type ProvidersFile, type Role } from "@crit/schema";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { askEffort, askFastModel, askModel, loadModels } from "./model-picker.ts";
import { duration } from "@/shared/lib/format.ts";
import { testProvider } from "./test-provider.ts";

export async function editProfileFlow(
  ctx: CliContext,
  file: ProvidersFile,
  existing: ProviderProfile,
  flags: {
    model?: string | null;
    effort?: string | null;
    fastModel?: string | null;
    enabled?: boolean;
    roles?: Role[];
    test?: boolean;
  },
): Promise<ProvidersFile> {
  const factory = ctx.registry.get(existing.type);
  let next = file;
  let model: string | null = existing.model;
  let effort: string | null = existing.effort ?? null;
  let fastModel: string | null = existing.fastModel ?? null;
  if (factory && ctx.interactive) {
    let models: ModelInfo[] | undefined;
    let info: ModelInfo | undefined;
    if (flags.model !== undefined) model = flags.model;
    else {
      const picked = await askModel(ctx, factory, {
        label: existing.name,
        command: existing.command,
        current: existing.model,
      });
      model = picked.model;
      info = picked.info;
      models = picked.models;
    }
    if (flags.effort !== undefined) effort = flags.effort;
    else
      effort = await askEffort(ctx, factory, {
        label: existing.name,
        info,
        current: existing.effort,
      });
    if (flags.fastModel !== undefined) fastModel = flags.fastModel;
    else {
      models ??= (await loadModels(ctx, factory, existing.command)).models;
      fastModel = await askFastModel(ctx, {
        label: existing.name,
        command: existing.command,
        current: existing.fastModel,
        models,
      });
    }
  } else {
    if (flags.model !== undefined) model = flags.model;
    if (flags.effort !== undefined) effort = flags.effort;
    if (flags.fastModel !== undefined) fastModel = flags.fastModel;
  }
  const enabled =
    flags.enabled !== undefined
      ? flags.enabled
      : ctx.interactive
        ? await ctx.prompter.confirm({ message: "Enabled", initialValue: existing.enabled })
        : existing.enabled;
  next = updateProfile(next, existing.name, { model, effort, fastModel, enabled });
  if (flags.roles !== undefined || ctx.interactive) {
    const current = (Object.entries(next.roles) as [Role, string][])
      .filter(([, n]) => n === existing.name)
      .map(([r]) => r);
    const roles =
      flags.roles ??
      (await ctx.prompter.multiselect<Role>({
        message: "Roles",
        options: [
          { value: "review", label: "review" },
          { value: "skeptic", label: "skeptic" },
          { value: "evaluate", label: "evaluate" },
        ],
        initialValues: current,
      }));
    for (const r of ["review", "skeptic", "evaluate"] as Role[]) {
      if (roles.includes(r)) next = setRole(next, r, existing.name);
      else if (next.roles[r] === existing.name) next = setRole(next, r, null);
    }
  }
  const test =
    flags.test ??
    (ctx.interactive
      ? await ctx.prompter.confirm({ message: "Test now?", initialValue: true })
      : false);
  if (test) {
    const r = await testProvider(
      ctx,
      next.providers.find((x) => x.name === existing.name)!,
    );
    if (r.ok) ctx.prompter.success(`replied in ${duration(r.ms)}`);
    else ctx.prompter.warn(r.error);
  }
  return next;
}
