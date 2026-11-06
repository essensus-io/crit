import { type CommandDef, defineCommand, renderUsage, runCommand } from "citty";
import pkg from "../package.json" with { type: "json" };
import { applyDef, openDef, undoDef } from "./commands/apply.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { historyDef } from "./commands/history.ts";
import { initCommand, mcpCommand } from "./commands/misc.ts";
import { providersCommand } from "./commands/providers.ts";
import { reviewCommand } from "./commands/review.ts";
import { rulesCommand } from "./commands/rules.ts";
import type { CliContext } from "./context.ts";
import { CliError, EXIT } from "./errors.ts";
import { PromptCancelled } from "./prompter.ts";
import { colors } from "./ui.ts";

export const VERSION = pkg.version;

export function createMain(ctx: CliContext): CommandDef {
  return defineCommand({
    meta: { name: "crit", version: VERSION, description: pkg.description },
    subCommands: {
      review: reviewCommand(ctx),
      open: openDef(ctx),
      apply: applyDef(ctx),
      undo: undoDef(ctx),
      history: historyDef(ctx),
      providers: providersCommand(ctx),
      rules: rulesCommand(ctx),
      doctor: doctorCommand(ctx),
      init: initCommand(ctx),
      mcp: mcpCommand(ctx),
    },
  });
}

/** Run crit with argv (without node and script) and return the exit code. Never calls process.exit. */
export async function runCli(rawArgv: string[], ctx: CliContext): Promise<number> {
  // `crit` alone in a terminal opens the start screen; piped, it prints help.
  const argv = rawArgv.length === 0 && ctx.interactive ? ["review"] : rawArgv;
  const main = createMain(ctx);
  const c = colors(ctx.color);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    ctx.out(`${await renderUsage(main)}\n`);
    return EXIT.ok;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    ctx.out(`${VERSION}\n`);
    return EXIT.ok;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    let cmd: CommandDef = main;
    let parent: CommandDef | undefined;
    for (const a of argv.filter((x) => !x.startsWith("-"))) {
      const subs = (
        typeof cmd.subCommands === "function" ? await cmd.subCommands() : await cmd.subCommands
      ) as Record<string, CommandDef> | undefined;
      if (!subs?.[a]) break;
      parent = cmd;
      cmd = subs[a];
    }
    ctx.out(`${await renderUsage(cmd, parent)}\n`);
    return EXIT.ok;
  }
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await runCommand(main, { rawArgs: argv });
    return typeof process.exitCode === "number" ? process.exitCode : EXIT.ok;
  } catch (err) {
    if (err instanceof PromptCancelled) {
      ctx.err("Cancelled.\n");
      return EXIT.cancelled;
    }
    if (err instanceof CliError) {
      ctx.err(`${c.red(err.message)}\n${err.hint ? `${err.hint}\n` : ""}`);
      return err.exitCode;
    }
    const e = err as Error & { code?: string };
    if (e.name === "CLIError" || e.code === "E_UNKNOWN_COMMAND" || e.code === "EARG") {
      ctx.err(`${c.red(e.message)}\nRun crit --help for usage.\n`);
      return EXIT.usage;
    }
    ctx.err(`${c.red(e.message)}\n`);
    if (ctx.env.CRIT_DEBUG) ctx.err(`${e.stack}\n`);
    return EXIT.error;
  } finally {
    process.exitCode = previous;
  }
}
