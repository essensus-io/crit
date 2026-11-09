import { styleText } from "node:util";
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
