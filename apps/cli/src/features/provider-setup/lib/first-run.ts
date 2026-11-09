import { addProfile, detectInstalled, emptyProvidersFile, setDefault } from "@crit/providers";
import { type ProvidersFile } from "@crit/schema";
import { providersPath, saveProviders } from "@crit/store";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { CliError } from "@/shared/lib/errors.ts";
import { profilePrompts } from "./profile-prompts.ts";
import { testAndReport } from "./test-and-report.ts";

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
    const command = d.path ?? d.factory.defaultCommand;
    const { name, model, effort, fastModel } = await profilePrompts(
      ctx,
      file,
      d.factory,
      undefined,
      command,
    );
    file = addProfile(file, { name, type, command, model, effort, fastModel });
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
