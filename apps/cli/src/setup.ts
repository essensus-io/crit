import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "@crit/core";
import {
  type AdapterFactory,
  addProfile,
  detectInstalled,
  emptyProvidersFile,
  type ProviderAdapter,
  setDefault,
  setRole,
  updateProfile,
} from "@crit/providers";
import { type ProviderProfile, ProviderName, type ProvidersFile, type Role } from "@crit/schema";
import { loadProviders, providersPath, saveProviders } from "@crit/store";
import type { CliContext } from "./context.ts";
import { CliError } from "./errors.ts";
import { colors, duration } from "./ui.ts";

export const CLI_DEFAULT = "__cli_default__";
const CUSTOM = "__custom__";

export function adapterFor(ctx: CliContext, profile: ProviderProfile): ProviderAdapter {
  const tmpDir = join(ctx.paths.cache, "runs");
  mkdirSync(tmpDir, { recursive: true });
  return ctx.registry.create(profile, { env: ctx.env, tmpDir });
}

export type TestResult = { ok: true; ms: number } | { ok: false; ms: number; error: string };

/** Run a short test prompt; failures carry a fix (e.g. "run `claude` once to log in"). */
export async function testProvider(ctx: CliContext, profile: ProviderProfile): Promise<TestResult> {
  const factory = ctx.registry.get(profile.type);
  const t0 = ctx.now();
  let adapter: ProviderAdapter;
  try {
    adapter = adapterFor(ctx, profile);
  } catch (err) {
    return { ok: false, ms: 0, error: (err as Error).message };
  }
  const detected = await adapter.detect();
  if (!detected.installed) {
    return {
      ok: false,
      ms: ctx.now() - t0,
      error: `${profile.command} not found · install it or fix the command with \`crit providers edit ${profile.name}\``,
    };
  }
  const out = await runAgent(
    adapter,
    {
      kind: "answer",
      cwd: ctx.cwd,
      systemPrompt: "",
      prompt: "This is a connectivity test. Reply with exactly the word: ok",
      timeoutMs: 120_000,
      ...(profile.model ? { model: profile.model } : {}),
    },
    new AbortController().signal,
  );
  const ms = ctx.now() - t0;
  if (out.ok && out.message !== undefined) return { ok: true, ms };
  const hint = factory?.loginHint ?? "check the CLI works on its own";
  const reason = out.rateLimited
    ? "rate limited, try again later"
    : (out.errors[0] ?? `exit code ${out.exitCode}`);
  const loginLike = /log(ged)? ?in|auth|api key|unauthori[sz]ed|credential/i.test(reason);
  return {
    ok: false,
    ms,
    error: loginLike
      ? `not logged in · ${hint}, then \`crit providers test ${profile.name}\``
      : reason,
  };
}

export function nonInteractiveSetupError(): CliError {
  return new CliError("crit: no providers configured, and this is not an interactive terminal.", {
    hint: "Add one with:\n  crit providers add claude-code --model opus --default",
    exitCode: 1,
  });
}

/** Load providers.json, running first-run setup when it does not exist. */
export async function ensureProviders(ctx: CliContext, continuing: string): Promise<ProvidersFile> {
  const existing = loadProviders(ctx.paths);
  if (existing && existing.providers.length > 0) return existing;
  if (!ctx.interactive) throw nonInteractiveSetupError();
  return firstRun(ctx, continuing);
}

async function askModel(
  ctx: CliContext,
  factory: AdapterFactory | undefined,
  label: string,
  current: string | null,
): Promise<string | null> {
  const models = factory?.models ?? [];
  const options = [
    { value: CLI_DEFAULT, label: "CLI default" },
    ...models.map((m) => ({ value: m, label: m })),
    { value: CUSTOM, label: "Other…" },
  ];
  const initial = current === null ? CLI_DEFAULT : models.includes(current) ? current : CUSTOM;
  const pick = await ctx.prompter.select({
    message: `Model for ${label}`,
    options,
    initialValue: initial,
  });
  if (pick === CLI_DEFAULT) return null;
  if (pick === CUSTOM)
    return (
      await ctx.prompter.text({
        message: "Model name",
        initialValue: current ?? "",
        validate: (v) => (v.trim() ? undefined : "enter a model name"),
      })
    ).trim();
  return pick;
}

const validateName = (file: ProvidersFile, except?: string) => (v: string) => {
  const r = ProviderName.safeParse(v.trim());
  if (!r.success) return r.error.issues[0]!.message;
  if (v.trim() !== except && file.providers.some((p) => p.name === v.trim()))
    return `${v.trim()} already exists`;
  return undefined;
};

/** Ask for a profile's name and model. */
export async function profilePrompts(
  ctx: CliContext,
  file: ProvidersFile,
  factory: AdapterFactory,
  existing?: ProviderProfile,
): Promise<{ name: string; model: string | null }> {
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
  const model = await askModel(ctx, factory, factory.label, existing?.model ?? null);
  return { name, model };
}

async function testAndReport(ctx: CliContext, profiles: ProviderProfile[]): Promise<void> {
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

/**
 * First run: detect agent CLIs, pick which to add, name + model for each,
 * pick the default, test each, save. Then the original command continues.
 */
export async function firstRun(ctx: CliContext, continuing: string): Promise<ProvidersFile> {
  const p = ctx.prompter;
  p.intro("crit · first run: let's add a provider");
  const detected = await detectInstalled(ctx.registry, ctx.env);
  p.note(
    detected
      .map((d) =>
        d.path
          ? `✓ ${d.factory.defaultCommand.padEnd(14)} ${d.path}${d.version ? ` (${d.version})` : ""}`
          : `✗ ${d.factory.defaultCommand.padEnd(14)} not found`,
      )
      .join("\n"),
    "Agent CLIs on your PATH",
  );
  const found = detected.filter((d) => d.path);
  if (found.length === 0) {
    throw new CliError("crit: no supported agent CLI found on your PATH.", {
      hint: `Install one of: ${detected.map((d) => `${d.factory.label} (${d.factory.defaultCommand})`).join(", ")}, then run crit again.`,
    });
  }
  const types = await p.multiselect({
    message: "Which providers do you want to add?",
    options: detected.map((d) => ({
      value: d.factory.type,
      label: `${d.factory.label}   (${d.factory.defaultCommand})`,
      ...(d.path ? {} : { hint: "not installed", disabled: true }),
    })),
    initialValues: found.map((d) => d.factory.type),
    required: true,
  });
  if (types.length === 0) throw new CliError("crit: no providers selected.");

  let file = emptyProvidersFile();
  for (const type of types) {
    const d = detected.find((x) => x.factory.type === type)!;
    const { name, model } = await profilePrompts(ctx, file, d.factory);
    file = addProfile(file, { name, type, command: d.path ?? d.factory.defaultCommand, model });
  }
  if (file.providers.length > 1) {
    const def = await p.select({
      message: "Default provider",
      options: file.providers.map((x) => ({ value: x.name, label: x.name })),
      initialValue: file.default!,
    });
    file = setDefault(file, def);
  }
  await testAndReport(ctx, file.providers);
  saveProviders(ctx.paths, file);
  p.outro(
    `Saved ${file.providers.length} provider${file.providers.length === 1 ? "" : "s"} to ${providersPath(ctx.paths)} · continuing: ${continuing}`,
  );
  return file;
}

/** Interactive add or edit of one profile. Flags skip the matching prompts. */
export async function editProfileFlow(
  ctx: CliContext,
  file: ProvidersFile,
  existing: ProviderProfile,
  flags: { model?: string | null; enabled?: boolean; roles?: Role[]; test?: boolean },
): Promise<ProvidersFile> {
  const factory = ctx.registry.get(existing.type);
  let next = file;
  const model =
    flags.model !== undefined
      ? flags.model
      : ctx.interactive
        ? await askModel(ctx, factory, existing.name, existing.model)
        : existing.model;
  const enabled =
    flags.enabled !== undefined
      ? flags.enabled
      : ctx.interactive
        ? await ctx.prompter.confirm({ message: "Enabled", initialValue: existing.enabled })
        : existing.enabled;
  next = updateProfile(next, existing.name, { model, enabled });
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
