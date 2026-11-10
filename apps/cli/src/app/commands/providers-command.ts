import { defineCommand } from "citty";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { addProvider } from "@/app/runners/providers/add-provider.ts";
import { editProvider } from "@/app/runners/providers/edit-provider.ts";
import { listProviderModels } from "@/app/runners/providers/list-provider-models.ts";
import { listProviders } from "@/app/runners/providers/list-providers.ts";
import { removeProviderCmd } from "@/app/runners/providers/remove-provider.ts";
import { setDefaultCmd } from "@/app/runners/providers/set-default-provider.ts";
import { setRoleCmd } from "@/app/runners/providers/set-provider-role.ts";
import { testProviders } from "@/app/runners/providers/test-providers.ts";

const run = (fn: () => Promise<number>) => async () => {
  process.exitCode = await fn();
};

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
