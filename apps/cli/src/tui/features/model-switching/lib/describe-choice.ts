import { type Choice } from "./create-switcher.ts";

export const describeChoice = (c: Choice) =>
  `${c.provider} · ${c.model ?? "default model"} · effort ${c.effort ?? "default"} · ${c.depth}`;

/** The choice as status-bar items. */
export const describeChoiceParts = (c: Choice) => [
  { k: "provider", v: c.provider, tone: "lav" as const },
  { k: "model", v: c.model ?? "default", tone: "lav" as const },
  { k: "effort", v: c.effort ?? "default", tone: "orange" as const },
  { k: "depth", v: c.depth, tone: "orange" as const },
];
