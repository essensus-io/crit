/** One palette for every screen, after the reference dashboard: mint, orange, lavender, on the terminal's own background. */
export const T = {
  mint: "#86efac",
  orange: "#fb923c",
  lav: "#a5b4fc",
  cyan: "#67e8f9",
  yellow: "#fde047",
  red: "#f87171",
  gray: "#9ca3af",
} as const;

export type Tone = keyof typeof T;

export const SEV_COLOR = {
  critical: T.red,
  major: T.orange,
  minor: T.yellow,
  nit: T.gray,
} as const;
export const SEV_LABEL = { critical: "CRIT", major: "MAJ", minor: "MIN", nit: "NIT" } as const;

/** Dashed box-drawing set used by every panel and flow connector. */
export const DASH = {
  topLeft: "┌",
  top: "╌",
  topRight: "┐",
  left: "╎",
  right: "╎",
  bottomLeft: "└",
  bottom: "╌",
  bottomRight: "┘",
} as const;

export const SPINNER = ["|", "/", "-", "\\"] as const;
