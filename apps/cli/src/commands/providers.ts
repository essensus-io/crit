import {
  addProfile,
  emptyProvidersFile,
  listModels,
  removeProfile,
  rolesOf,
  setDefault,
  setRole,
} from "@crit/providers";
import { type ProvidersFile, Role } from "@crit/schema";
import { loadProviders, saveProviders } from "@crit/store";
import { defineCommand } from "citty";
import type { CliContext } from "../context.ts";
import { CliError, EXIT } from "../shared/lib/errors.ts";
import { editProfileFlow, firstRun, profilePrompts, testProvider } from "../setup.ts";
import { colors, duration, table } from "../ui.ts";

function load(ctx: CliContext): ProvidersFile {
  return loadProviders(ctx.paths) ?? emptyProvidersFile();
}

const need = (file: ProvidersFile, name: string) => {
  const p = file.providers.find((x) => x.name === name);
  if (!p)
    throw new CliError(`crit: no provider named "${name}"`, {
      hint: `Have: ${file.providers.map((x) => x.name).join(", ") || "none"}. Add one with \`crit providers add\`.`,
    });
  return p;
};

const parseModel = (v: string | undefined): string | null | undefined =>
  v === undefined ? undefined : v === "default" || v === "" ? null : v;

function parseRoles(v: string | undefined): Role[] | undefined {
  if (v === undefined) return undefined;
  const list = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const r of list)
    if (!Role.safeParse(r).success)
      throw new CliError(`crit: unknown role ${r} (use review, skeptic, evaluate)`, {
        exitCode: EXIT.usage,
      });
  return list as Role[];
}

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
        hint: `Types: ${types.map((t) => t.type).join(", ")}`,
      });
    type = await ctx.prompter.select({
      message: "Provider type",
      options: types.map((t) => ({ value: t.type, label: `${t.label} (${t.defaultCommand})` })),
    });
  }
  const factory = ctx.registry.get(type);
  if (!factory)
    throw new CliError(`crit: unknown provider type ${type}`, {
      exitCode: EXIT.usage,
      hint: `Types: ${types.map((t) => t.type).join(", ")}`,
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
  name ??= file.providers.some((p) => p.name === factory.defaultName)
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
  const profile = file.providers.find((p) => p.name === name)!;
  if (args.test ?? ctx.interactive) {
    const r = await testProvider(ctx, profile);
    if (r.ok) ctx.err(`✓ ${name} replied in ${duration(r.ms)}\n`);
    else ctx.err(colors(ctx.color).yellow(`✗ ${name} ${r.error}\n`));
  }
  saveProviders(ctx.paths, file);
  ctx.out(`Added ${name}${file.default === name ? " (default)" : ""}\n`);
  return EXIT.ok;
}

export async function editProvider(
  ctx: CliContext,
  name: string,
  args: {
    model?: string;
    effort?: string;
    "fast-model"?: string;
    enabled?: boolean;
    roles?: string;
    test?: boolean;
  },
): Promise<number> {
  const file = load(ctx);
  const profile = need(file, name);
  const roles = parseRoles(args.roles);
  const next = await editProfileFlow(ctx, file, profile, {
    ...(args.model !== undefined ? { model: parseModel(args.model)! } : {}),
    ...(args.effort !== undefined ? { effort: parseModel(args.effort)! } : {}),
    ...(args["fast-model"] !== undefined ? { fastModel: parseModel(args["fast-model"])! } : {}),
    ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
    ...(roles ? { roles } : {}),
    ...(args.test !== undefined ? { test: args.test } : {}),
  });
  if (next.default === name && !next.providers.find((p) => p.name === name)!.enabled) {
    throw new CliError(
      `crit: ${name} is the default provider; choose another default before disabling it`,
    );
  }
  saveProviders(ctx.paths, next);
  ctx.out(`Updated ${name}\n`);
  return EXIT.ok;
}

export async function listProviderModels(
  ctx: CliContext,
  target: string | undefined,
  args: { search?: string; json?: boolean },
): Promise<number> {
  const file = loadProviders(ctx.paths);
  const profile = target ? file?.providers.find((p) => p.name === target) : undefined;
  const byDefault = !target ? file?.providers.find((p) => p.name === file.default) : undefined;
  const chosen = profile ?? byDefault;
  const factory = ctx.registry.get(chosen?.type ?? target ?? "");
  if (!factory)
    throw new CliError(`crit: ${target ?? "no provider"} is not a provider name or type`, {
      hint: `Providers: ${file?.providers.map((p) => p.name).join(", ") || "none"}. Types: ${ctx.registry
        .list()
        .map((f) => f.type)
        .join(", ")}.`,
    });
  const command = chosen?.command ?? factory.defaultCommand;
  const { models, live } = await listModels(factory, { command, env: ctx.env });
  const q = args.search?.toLowerCase();
  const shown = q
    ? models.filter((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
    : models;
  if (args.json) {
    ctx.out(
      `${JSON.stringify({ provider: chosen?.name ?? null, type: factory.type, live, current: chosen?.model ?? null, models: shown }, null, 2)}\n`,
    );
    return EXIT.ok;
  }
  const c = colors(ctx.color);
  const rows = [["", c.dim("MODEL ID"), c.dim("NAME"), c.dim("EFFORTS")]];
  for (const m of shown)
    rows.push([
      m.id === chosen?.model ? "●" : " ",
      m.id,
      m.label,
      m.efforts?.length
        ? `${m.efforts.join(" ")}${m.defaultEffort ? c.dim(` (default ${m.defaultEffort})`) : ""}`
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

export async function removeProviderCmd(
  ctx: CliContext,
  name: string,
  args: { yes?: boolean; default?: string },
): Promise<number> {
  const file = load(ctx);
  need(file, name);
  const isDefault = file.default === name;
  if (!args.yes) {
    if (!ctx.interactive)
      throw new CliError(`crit: pass --yes to remove ${name}`, { exitCode: EXIT.usage });
    const ok = await ctx.prompter.confirm({
      message: isDefault ? `${name} is your default. Remove it?` : `Remove ${name}?`,
      initialValue: false,
    });
    if (!ok) return EXIT.cancelled;
  }
  let newDefault = args.default;
  const rest = file.providers.filter((p) => p.name !== name);
  if (isDefault && rest.length > 0 && !newDefault) {
    if (rest.length === 1) newDefault = rest[0]!.name;
    else if (ctx.interactive)
      newDefault = await ctx.prompter.select({
        message: "New default",
        options: rest.map((p) => ({ value: p.name, label: p.name })),
      });
    else
      throw new CliError(
        `crit: ${name} is the default; pass --default <name> to choose a new one`,
        { exitCode: EXIT.usage },
      );
  }
  const roles = rolesOf(file, name);
  saveProviders(ctx.paths, removeProfile(file, name, newDefault));
  ctx.out(
    `Removed ${name}${newDefault && isDefault ? ` · default is now ${newDefault}` : ""}${roles.length ? ` · cleared roles ${roles.join(", ")}` : ""}\n`,
  );
  return EXIT.ok;
}

export async function setDefaultCmd(ctx: CliContext, name: string): Promise<number> {
  saveProviders(ctx.paths, setDefault(load(ctx), name));
  ctx.out(`Default provider: ${name}\n`);
  return EXIT.ok;
}

export async function setRoleCmd(
  ctx: CliContext,
  role: string,
  name: string | undefined,
): Promise<number> {
  if (!Role.safeParse(role).success)
    throw new CliError(`crit: unknown role ${role}`, { exitCode: EXIT.usage });
  saveProviders(ctx.paths, setRole(load(ctx), role as Role, name ?? null));
  ctx.out(name ? `${role} → ${name}\n` : `Cleared role ${role}\n`);
  return EXIT.ok;
}

export async function testProviders(ctx: CliContext, name?: string): Promise<number> {
  const file = load(ctx);
  const list = name ? [need(file, name)] : file.providers.filter((p) => p.enabled);
  if (list.length === 0)
    throw new CliError("crit: no providers to test", {
      hint: "Add one with `crit providers add`.",
    });
  const c = colors(ctx.color);
  let failed = 0;
  for (const p of list) {
    const r = await testProvider(ctx, p);
    if (r.ok) ctx.out(`${c.green("✓")} ${p.name.padEnd(12)} replied in ${duration(r.ms)}\n`);
    else {
      failed++;
      ctx.out(`${c.red("✗")} ${p.name.padEnd(12)} ${r.error}\n`);
    }
  }
  return failed ? EXIT.error : EXIT.ok;
}

const run = (fn: () => Promise<number>) => async () => {
  process.exitCode = await fn();
};

export async function chooseReviewProvider(ctx: CliContext): Promise<string> {
  const file = load(ctx);
  const choice = await ctx.prompter.select({
    message:
      "Retry review with a provider (starts a new review; previous findings stay in history)",
    options: [
      ...file.providers
        .filter((p) => p.enabled)
        .map((p) => ({
          value: p.name,
          label: `${p.name} (${p.type}, ${p.model ?? "CLI default"})`,
        })),
      { value: "__add__", label: "Connect another provider…" },
    ],
  });
  if (choice !== "__add__") return choice;
  await addProvider(ctx, {});
  const added = load(ctx).providers.find((p) => !file.providers.some((old) => old.name === p.name));
  if (!added) throw new CliError("crit: no new provider was added");
  return added.name;
}

export const providersCommand = (ctx: CliContext) =>
  defineCommand({
    meta: { name: "providers", description: "List and manage provider profiles" },
    subCommands: {
      list: defineCommand({
        meta: { name: "list", description: "List providers with status, version and default" },
        run: run(() => listProviders(ctx)),
      }),
      add: defineCommand({
        meta: { name: "add", description: "Add a provider profile" },
        args: {
          type: {
            type: "positional",
            required: false,
            description: "claude-code, codex or cursor",
          },
          name: { type: "string", description: "Profile name" },
          model: { type: "string", description: "Model, or 'default' for the CLI default" },
          effort: { type: "string", description: "Reasoning effort, or 'default'" },
          "fast-model": {
            type: "string",
            description: "Cheaper model for the skeptic and repo map, or 'default' for the same",
          },
          command: { type: "string", description: "Path to the agent CLI" },
          default: { type: "boolean", description: "Make it the default" },
          test: {
            type: "boolean",
            description: "Run a short test prompt (default: yes in a terminal)",
          },
        },
        run: async ({ args }) => {
          process.exitCode = await addProvider(ctx, args as never);
        },
      }),
      edit: defineCommand({
        meta: { name: "edit", description: "Edit a provider profile" },
        args: {
          name: { type: "positional", required: true },
          model: { type: "string", description: "Model, or 'default' for the CLI default" },
          effort: { type: "string", description: "Reasoning effort, or 'default'" },
          "fast-model": {
            type: "string",
            description: "Cheaper model for the skeptic and repo map, or 'default' for the same",
          },
          enabled: { type: "boolean" },
          roles: { type: "string", description: "Comma-separated: review, skeptic, evaluate" },
          test: { type: "boolean" },
        },
        run: async ({ args }) => {
          process.exitCode = await editProvider(ctx, args.name, args as never);
        },
      }),
      models: defineCommand({
        meta: {
          name: "models",
          description: "List the models an agent CLI offers (a profile name or a type like codex)",
        },
        args: {
          name: { type: "positional", required: false },
          search: { type: "string", description: "Only models whose id or name contains this" },
          json: { type: "boolean", description: "Print JSON" },
        },
        run: async ({ args }) => {
          process.exitCode = await listProviderModels(ctx, args.name, args);
        },
      }),
      remove: defineCommand({
        meta: { name: "remove", description: "Remove a provider profile" },
        args: {
          name: { type: "positional", required: true },
          yes: { type: "boolean", alias: "y" },
          default: { type: "string", description: "New default if removing the default" },
        },
        run: async ({ args }) => {
          process.exitCode = await removeProviderCmd(ctx, args.name, args as never);
        },
      }),
      default: defineCommand({
        meta: { name: "default", description: "Set the default provider" },
        args: { name: { type: "positional", required: true } },
        run: async ({ args }) => {
          process.exitCode = await setDefaultCmd(ctx, args.name);
        },
      }),
      role: defineCommand({
        meta: {
          name: "role",
          description:
            "Assign a provider to a role (review, skeptic, evaluate); omit the name to clear it",
        },
        args: {
          role: { type: "positional", required: true },
          name: { type: "positional", required: false },
        },
        run: async ({ args }) => {
          process.exitCode = await setRoleCmd(ctx, args.role, args.name);
        },
      }),
      test: defineCommand({
        meta: { name: "test", description: "Run a short test prompt on one or all providers" },
        args: { name: { type: "positional", required: false } },
        run: async ({ args }) => {
          process.exitCode = await testProviders(ctx, args.name);
        },
      }),
    },
    run: async ({ rawArgs }) => {
      if (rawArgs.length === 0) process.exitCode = await listProviders(ctx);
    },
  });
