import { stripVTControlCharacters, styleText } from "node:util";
import type { Severity } from "@crit/schema";

type Style = Parameters<typeof styleText>[0];

export type Colors = ReturnType<typeof colors>;

export function colors(enabled: boolean) {
  const c = (style: Style) => (s: string) =>
    enabled ? styleText(style, s, { validateStream: false }) : s;
  return {
    bold: c("bold"),
    dim: c("dim"),
    red: c("red"),
    yellow: c("yellow"),
    green: c("green"),
    cyan: c("cyan"),
    magenta: c("magenta"),
    gray: c("gray"),
  };
}

export const SEVERITY_SHORT: Record<Severity, string> = {
  critical: "CRIT",
  major: "MAJ",
  minor: "MIN",
  nit: "NIT",
};
export const SEVERITY_LETTER: Record<Severity, string> = {
  critical: "C",
  major: "M",
  minor: "m",
  nit: "n",
};

export function severityColor(c: Colors, s: Severity) {
  return s === "critical" ? c.red : s === "major" ? c.yellow : s === "minor" ? c.cyan : c.gray;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m}m${String(s).padStart(2, "0")}s` : `${m}m`;
}

export function when(ts: number, now: number): string {
  const d = new Date(ts);
  const n = new Date(now);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((day(n) - day(d)) / 86_400_000);
  if (diffDays === 0) return `today ${hhmm}`;
  if (diffDays === 1) return `yesterday ${hhmm}`;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== n.getFullYear() ? { year: "numeric" } : {}),
  });
}

export const visibleLength = (s: string) => stripVTControlCharacters(s).length;
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visibleLength(s)));

export function table(rows: string[][], indent = "  "): string {
  const widths: number[] = [];
  for (const r of rows)
    r.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell))));
  return rows
    .map(
      (r) =>
        indent +
        r
          .map((cell, i) => (i === r.length - 1 ? cell : pad(cell, widths[i]!)))
          .join("  ")
          .trimEnd(),
    )
    .join("\n");
}

export const plural = (n: number, word: string, many = `${word}s`) =>
  `${n} ${n === 1 ? word : many}`;

export const truncate = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
