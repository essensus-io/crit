import { type AdapterFactory, listModels, type ModelInfo } from "@crit/providers";
import type { CliContext } from "../../../context.ts";
import type { Option } from "../../../shared/lib/prompter.ts";

export const CLI_DEFAULT = "__cli_default__";
const CUSTOM = "__custom__";
const SAME = "__same__";
const SEARCH_ABOVE = 12;

export async function loadModels(
  ctx: CliContext,
  factory: AdapterFactory,
  command: string,
): Promise<{ models: ModelInfo[]; live: boolean }> {
  if (!factory.listModels) return listModels(factory, { command, env: ctx.env });
  const s = ctx.prompter.spinner();
  s.start(`Loading ${factory.label} models`);
  const r = await listModels(factory, { command, env: ctx.env });
  s.stop(
    r.live
      ? `${r.models.length} ${factory.label} models`
      : `Using a built-in ${factory.label} model list (the CLI did not list its own)`,
  );
  return r;
}

const toOption = (m: ModelInfo): Option<string> => ({
  value: m.id,
  label: m.label,
  ...(m.id !== m.label || m.hint
    ? { hint: [m.id !== m.label ? m.id : "", m.hint ?? ""].filter(Boolean).join(" · ") }
    : {}),
});

async function pick(
  ctx: CliContext,
  message: string,
  options: Option<string>[],
  initialValue: string,
): Promise<string> {
  return options.length > SEARCH_ABOVE
    ? ctx.prompter.autocomplete({ message: `${message} (type to search)`, options, initialValue })
    : ctx.prompter.select({ message, options, initialValue });
}

async function customName(ctx: CliContext, current: string | null): Promise<string> {
  return (
    await ctx.prompter.text({
      message: "Model name",
      initialValue: current ?? "",
      validate: (v) => (v.trim() ? undefined : "enter a model name"),
    })
  ).trim();
}

export async function askModel(
  ctx: CliContext,
  factory: AdapterFactory,
  opts: { label: string; command: string; current: string | null; models?: ModelInfo[] },
): Promise<{ model: string | null; info?: ModelInfo; models: ModelInfo[] }> {
  const models = opts.models ?? (await loadModels(ctx, factory, opts.command)).models;
  const known = models.some((m) => m.id === opts.current);
  const options: Option<string>[] = [
    {
      value: CLI_DEFAULT,
      label: "CLI default",
      ...(factory.defaultModelNote ? { hint: factory.defaultModelNote } : {}),
    },
    ...(opts.current && !known
      ? [{ value: opts.current, label: opts.current, hint: "current" }]
      : []),
    ...models.map(toOption),
    { value: CUSTOM, label: "Other…", hint: "type a model name" },
  ];
  const chosen = await pick(ctx, `Model for ${opts.label}`, options, opts.current ?? CLI_DEFAULT);
  if (chosen === CLI_DEFAULT) return { model: null, models };
  const model = chosen === CUSTOM ? await customName(ctx, opts.current) : chosen;
  const info = models.find((m) => m.id === model);
  return { model, ...(info ? { info } : {}), models };
}

export async function askEffort(
  ctx: CliContext,
  factory: AdapterFactory,
  opts: { label: string; info: ModelInfo | undefined; current: string | null | undefined },
): Promise<string | null> {
  const efforts = opts.info?.efforts?.length ? opts.info.efforts : factory.efforts;
  if (efforts.length === 0) return null;
  const current = opts.current && efforts.includes(opts.current) ? opts.current : null;
  const options: Option<string>[] = [
    {
      value: CLI_DEFAULT,
      label: "CLI default",
      ...(opts.info?.defaultEffort ? { hint: opts.info.defaultEffort } : {}),
    },
    ...efforts.map((e) => ({ value: e, label: e })),
  ];
  const chosen = await ctx.prompter.select({
    message: `Reasoning effort for ${opts.label}`,
    options,
    initialValue: current ?? CLI_DEFAULT,
  });
  return chosen === CLI_DEFAULT ? null : chosen;
}

export async function askFastModel(
  ctx: CliContext,
  opts: { label: string; command: string; current: string | null | undefined; models: ModelInfo[] },
): Promise<string | null> {
  const options: Option<string>[] = [
    { value: SAME, label: "Same as the main model" },
    ...(opts.current && !opts.models.some((m) => m.id === opts.current)
      ? [{ value: opts.current, label: opts.current, hint: "current" }]
      : []),
    ...opts.models.map(toOption),
    { value: CUSTOM, label: "Other…", hint: "type a model name" },
  ];
  const chosen = await pick(
    ctx,
    `Cheaper model for ${opts.label}'s skeptic and repo map`,
    options,
    opts.current ?? SAME,
  );
  if (chosen === SAME) return null;
  return chosen === CUSTOM ? customName(ctx, opts.current ?? null) : chosen;
}
