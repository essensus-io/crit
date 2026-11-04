import { DatabaseSync } from "node:sqlite";
import { tryGit } from "@crit/core";
import { compareVersions } from "@crit/providers";
import {
  dbPath,
  loadProjectConfig,
  loadProviders,
  loadUserConfig,
  SettingsError,
} from "@crit/store";
import { defineCommand } from "citty";
import type { CliContext } from "../context.ts";
import { EXIT } from "../errors.ts";
import { colors } from "../ui.ts";

type Check = { name: string; ok: boolean; warn?: boolean; detail: string };

/** `crit doctor`: installed agent CLIs, logins and versions, plus crit's own setup. */
export async function doctor(ctx: CliContext, opts: { test?: boolean } = {}): Promise<number> {
  const checks: Check[] = [];
  const node = process.versions.node;
  checks.push({
    name: "node",
    ok: compareVersions(node, "24.0.0") >= 0,
    detail: `v${node}${compareVersions(node, "24.0.0") < 0 ? " (crit needs Node 24 or newer)" : ""}`,
  });
  const gitVersion = await tryGit(ctx.cwd, ["--version"]);
  checks.push({ name: "git", ok: Boolean(gitVersion), detail: gitVersion ?? "not found on PATH" });
  try {
    const db = new DatabaseSync(":memory:");
    const v = (db.prepare("select sqlite_version() v").get() as { v: string }).v;
    db.close();
    checks.push({ name: "sqlite", ok: true, detail: `node:sqlite ${v} · ${dbPath(ctx.paths)}` });
  } catch (err) {
    checks.push({ name: "sqlite", ok: false, detail: (err as Error).message });
  }

  for (const f of ctx.registry.list()) {
    const adapter = ctx.registry.create(
      { name: f.type, type: f.type, command: f.defaultCommand, model: null, enabled: true },
      { env: ctx.env, tmpDir: ctx.paths.cache },
    );
    const d = await adapter.detect();
    checks.push({
      name: f.defaultCommand,
      ok: d.installed,
      warn: !d.installed || d.untestedVersion,
      detail: !d.installed
        ? "not installed"
        : `${d.version ?? "unknown version"}${d.untestedVersion ? " · not tested with this crit version" : ""} · ${d.path}`,
    });
  }

  let providers;
  try {
    providers = loadProviders(ctx.paths);
    checks.push({
      name: "providers.json",
      ok: true,
      warn: !providers,
      detail: providers
        ? `${providers.providers.length} profiles, default ${providers.default ?? "none"}`
        : "not set up yet (run any crit command)",
    });
  } catch (err) {
    checks.push({
      name: "providers.json",
      ok: false,
      detail: err instanceof SettingsError ? err.message : String(err),
    });
  }
  for (const [label, load] of [
    ["config.json (yours)", () => loadUserConfig(ctx.paths)],
    [
      ".crit/config.json",
      async () =>
        loadProjectConfig((await tryGit(ctx.cwd, ["rev-parse", "--show-toplevel"])) ?? ctx.cwd),
    ],
  ] as const) {
    try {
      const cfg = await load();
      checks.push({ name: label, ok: true, warn: false, detail: cfg ? "valid" : "none" });
    } catch (err) {
      checks.push({ name: label, ok: false, detail: (err as Error).message });
    }
  }

  if (opts.test && providers) {
    const { testProvider } = await import("../setup.ts");
    for (const p of providers.providers.filter((x) => x.enabled)) {
      const r = await testProvider(ctx, p);
      checks.push({ name: `test ${p.name}`, ok: r.ok, detail: r.ok ? "replied" : r.error });
    }
  }

  const c = colors(ctx.color);
  for (const ch of checks) {
    const mark = !ch.ok ? c.red("✗") : ch.warn ? c.yellow("!") : c.green("✓");
    ctx.out(`${mark} ${ch.name.padEnd(20)} ${ch.ok ? ch.detail : c.red(ch.detail)}\n`);
  }
  const agents = checks.filter((ch) =>
    ctx.registry.list().some((f) => f.defaultCommand === ch.name),
  );
  if (!agents.some((a) => a.ok))
    ctx.out(
      c.yellow(
        "\nNo supported agent CLI is installed. Install Claude Code, Codex or Cursor's agent CLI.\n",
      ),
    );
  const critical = checks.filter((ch) => !ch.ok && !agents.includes(ch));
  return critical.length ? EXIT.error : EXIT.ok;
}

export const doctorCommand = (ctx: CliContext) =>
  defineCommand({
    meta: { name: "doctor", description: "Check installed agent CLIs, logins and versions" },
    args: {
      test: { type: "boolean", description: "Also run a short test prompt on each provider" },
    },
    run: async ({ args }) => {
      process.exitCode = await doctor(ctx, args);
    },
  });
