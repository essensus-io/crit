import { CliError, EXIT } from "@/shared/lib/errors.ts";

export function parseAge(s: string): number {
  const m = /^(\d+)\s*([hdw])$/.exec(s.trim());
  if (!m)
    throw new CliError(`crit: cannot read "${s}"; use e.g. 90d, 12w or 24h`, {
      exitCode: EXIT.usage,
    });
  const n = Number(m[1]);
  return n * { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as "h" | "d" | "w"];
}

export function parseSince(s: string, now: number): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00`).getTime();
  return now - parseAge(s);
}
