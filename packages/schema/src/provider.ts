import { z } from "zod";

export const KNOWN_PROVIDER_TYPES = ["claude-code", "codex", "cursor"] as const;
export type KnownProviderType = (typeof KNOWN_PROVIDER_TYPES)[number];

export const ProviderName = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, "use letters, digits, '.', '_' or '-'");

export const ProviderProfile = z.object({
  name: ProviderName,
  type: z.string().min(1),
  command: z.string().min(1),
  model: z.string().nullable().default(null),
  effort: z.string().nullable().optional(),
  fastModel: z.string().nullable().optional(),
  enabled: z.boolean().default(true),
  env: z.record(z.string(), z.string()).optional(),
});
export type ProviderProfile = z.infer<typeof ProviderProfile>;
export type ProviderProfileInput = z.input<typeof ProviderProfile>;

export const Role = z.enum(["review", "skeptic", "evaluate", "map"]);
export type Role = z.infer<typeof Role>;

export const Roles = z.partialRecord(Role, ProviderName);
export type Roles = z.infer<typeof Roles>;

export const ProvidersFile = z
  .object({
    $schema: z.string().optional(),
    default: ProviderName.nullable().default(null),
    providers: z.array(ProviderProfile).default([]),
    roles: Roles.default({}),
  })
  .superRefine((file, ctx) => {
    const names = new Set<string>();
    for (const [i, p] of file.providers.entries()) {
      if (names.has(p.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", i, "name"],
          message: `duplicate provider name "${p.name}"`,
        });
      }
      names.add(p.name);
    }
    if (file.default !== null && !names.has(file.default)) {
      ctx.addIssue({
        code: "custom",
        path: ["default"],
        message: `default "${file.default}" is not a provider`,
      });
    }
    for (const [role, name] of Object.entries(file.roles)) {
      if (name && !names.has(name)) {
        ctx.addIssue({
          code: "custom",
          path: ["roles", role],
          message: `role ${role} points at unknown provider "${name}"`,
        });
      }
    }
  });
export type ProvidersFile = z.infer<typeof ProvidersFile>;
