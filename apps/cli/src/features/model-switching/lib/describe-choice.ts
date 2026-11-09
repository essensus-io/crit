import { type Choice } from "./create-switcher.ts";

export const describeChoice = (choice: Choice) =>
  `${choice.provider} · ${choice.model ?? "default model"} · effort ${choice.effort ?? "default"} · ${choice.depth}`;

export const describeChoiceParts = (choice: Choice) => [
  { k: "provider", v: choice.provider, tone: "lav" as const },
  { k: "model", v: choice.model ?? "default", tone: "lav" as const },
  { k: "effort", v: choice.effort ?? "default", tone: "orange" as const },
  { k: "depth", v: choice.depth, tone: "orange" as const },
];
