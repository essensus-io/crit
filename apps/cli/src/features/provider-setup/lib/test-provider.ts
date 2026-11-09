import { runAgent } from "@crit/core";
import { type ProviderAdapter } from "@crit/providers";
import { type ProviderProfile } from "@crit/schema";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { adapterFor } from "./adapter-for.ts";

export type TestResult = { ok: true; ms: number } | { ok: false; ms: number; error: string };

export async function testProvider(ctx: CliContext, profile: ProviderProfile): Promise<TestResult> {
  const factory = ctx.registry.get(profile.type);
  const t0 = ctx.now();
  let adapter: ProviderAdapter;
  try {
    adapter = adapterFor(ctx, profile);
  } catch (err) {
    return { ok: false, ms: 0, error: (err as Error).message };
  }
  const detected = await adapter.detect();
  if (!detected.installed) {
    return {
      ok: false,
      ms: ctx.now() - t0,
      error: `${profile.command} not found · install it or fix the command with \`crit providers edit ${profile.name}\``,
    };
  }
  const out = await runAgent(
    adapter,
    {
      kind: "answer",
      cwd: ctx.cwd,
      systemPrompt: "",
      prompt: "This is a connectivity test. Reply with exactly the word: ok",
      timeoutMs: 120_000,
      ...(profile.model ? { model: profile.model } : {}),
    },
    new AbortController().signal,
  );
  const ms = ctx.now() - t0;
  if (out.ok && out.message !== undefined) return { ok: true, ms };
  const hint = factory?.loginHint ?? "check the CLI works on its own";
  const reason = out.rateLimited
    ? "rate limited, try again later"
    : (out.errors[0] ?? `exit code ${out.exitCode}`);
  const loginLike = /log(ged)? ?in|auth|api key|unauthori[sz]ed|credential/i.test(reason);
  return {
    ok: false,
    ms,
    error: loginLike
      ? `not logged in · ${hint}, then \`crit providers test ${profile.name}\``
      : reason,
  };
}
