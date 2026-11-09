import type { RuleLayer } from "@crit/schema";
import type { RuleFile } from "./parse.ts";
import { discoverGlobalRules, discoverProjectRules, discoverUserRules } from "./sources.ts";

export * from "./parse.ts";
export * from "./disabled.ts";
export * from "./select.ts";
export * from "./sources.ts";

export type DiscoverOptions = {
  root: string;
  home: string;
  configDir: string;
  include?: string[];
  sources?: RuleLayer[];
};

export async function discoverRules(opts: DiscoverOptions): Promise<RuleFile[]> {
  const sources = new Set(opts.sources ?? ["project", "global", "user"]);
  return [
    ...(sources.has("project") ? await discoverProjectRules(opts.root, opts.include) : []),
    ...(sources.has("global") ? discoverGlobalRules(opts.home) : []),
    ...(sources.has("user") ? discoverUserRules(opts.configDir, opts.home) : []),
  ];
}
