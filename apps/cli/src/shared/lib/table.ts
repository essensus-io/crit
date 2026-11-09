import { stripVTControlCharacters } from "node:util";

export const visibleLength = (s: string) => stripVTControlCharacters(s).length;

const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visibleLength(s)));

export function table(rows: string[][], indent = "  "): string {
  const widths: number[] = [];
  for (const row of rows)
    row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell))));
  return rows
    .map(
      (row) =>
        indent +
        row
          .map((cell, i) => (i === row.length - 1 ? cell : pad(cell, widths[i]!)))
          .join("  ")
          .trimEnd(),
    )
    .join("\n");
}
