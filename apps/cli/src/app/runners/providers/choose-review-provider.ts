import type { CliContext } from "@/shared/lib/cli-context.ts";
import { CliError } from "@/shared/lib/errors.ts";
import { addProvider } from "./add-provider.ts";
import { load } from "./providers-file.ts";

export async function chooseReviewProvider(ctx: CliContext): Promise<string> {
  const file = load(ctx);
  const choice = await ctx.prompter.select({
    message:
      "Retry review with a provider (starts a new review; previous findings stay in history)",
    options: [
      ...file.providers
        .filter((provider) => provider.enabled)
        .map((p) => ({
          value: p.name,
          label: `${p.name} (${p.type}, ${p.model ?? "CLI default"})`,
        })),
      { value: "__add__", label: "Connect another provider…" },
    ],
  });
  if (choice !== "__add__") return choice;
  await addProvider(ctx, {});
  const added = load(ctx).providers.find(
    (provider) => !file.providers.some((old) => old.name === provider.name),
  );
  if (!added) throw new CliError("crit: no new provider was added");
  return added.name;
}
