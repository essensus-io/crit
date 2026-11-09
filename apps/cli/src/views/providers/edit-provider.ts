import { saveProviders } from "@crit/store";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { CliError, EXIT } from "@/shared/lib/errors.ts";
import { editProfileFlow } from "@/features/provider-setup/lib/edit-profile-flow.ts";
import { load, need } from "./providers-file.ts";
import { parseModel, parseRoles } from "./parse-provider-args.ts";

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
  if (
    next.default === name &&
    !next.providers.find((provider) => provider.name === name)!.enabled
  ) {
    throw new CliError(
      `crit: ${name} is the default provider; choose another default before disabling it`,
    );
  }
  saveProviders(ctx.paths, next);
  ctx.out(`Updated ${name}\n`);
  return EXIT.ok;
}
