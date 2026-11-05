import {
  addProfile,
  emptyProvidersFile,
  removeProfile,
  rolesOf,
  setDefault,
  setRole,
} from "@crit/providers";
import { type ProvidersFile, Role } from "@crit/schema";
import { loadProviders, saveProviders } from "@crit/store";
import { defineCommand } from "citty";
import type { CliContext } from "../context.ts";
import { CliError, EXIT } from "../errors.ts";
import { CLI_DEFAULT, editProfileFlow, firstRun, profilePrompts, testProvider } from "../setup.ts";
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

/** `crit providers`: each profile's status, version and default. */
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
  if (ctx.interactive && (name === undefined || model === undefined)) {
    const answers = await profilePrompts(ctx, file, factory);
    name ??= answers.name;
    if (model === undefined) model = answers.model === CLI_DEFAULT ? null : answers.model;
  }
  name ??= file.providers.some((p) => p.name === factory.defaultName)
    ? `${factory.defaultName}-2`
    : factory.defaultName;
  file = addProfile(
    file,
    { name, type, command: args.command ?? factory.defaultCommand, model: model ?? null },
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
  args: { model?: string; enabled?: boolean; roles?: string; test?: boolean },
): Promise<number> {
  const file = load(ctx);
  const profile = need(file, name);
  const roles = parseRoles(args.roles);
  const next = await editProfileFlow(ctx, file, profile, {
    ...(args.model !== undefined ? { model: parseModel(args.model)! } : {}),
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

/** Called after the review screen releases the terminal, so setup can prompt safely. */
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
          model: { type: "string" },
          enabled: { type: "boolean" },
          roles: { type: "string", description: "Comma-separated: review, skeptic, evaluate" },
          test: { type: "boolean" },
        },
        run: async ({ args }) => {
          process.exitCode = await editProvider(ctx, args.name, args as never);
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
