import type { ResolvedConfig } from "@crit/schema";
import type { ProviderRun } from "./review-types.ts";

export const modelOf = (
  provider: ProviderRun,
  kind: "main" | "fast" = "main",
  depthEffort?: string,
): { model?: string; effort?: string } => {
  const model = (kind === "fast" && provider.profile.fastModel) || provider.profile.model;
  const effort = kind === "fast" ? "low" : (provider.profile.effort ?? depthEffort);
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
};

export const depthEffort = (depth: ResolvedConfig["depth"]): string | undefined =>
  depth === "quick" ? "low" : depth === "deep" ? "high" : undefined;
