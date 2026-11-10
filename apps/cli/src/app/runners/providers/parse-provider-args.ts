import { Role } from "@crit/schema";
import { CliError, EXIT } from "@/shared/lib/errors.ts";

export const parseModel = (v: string | undefined): string | null | undefined =>
  v === undefined ? undefined : v === "default" || v === "" ? null : v;

export function parseRoles(v: string | undefined): Role[] | undefined {
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
