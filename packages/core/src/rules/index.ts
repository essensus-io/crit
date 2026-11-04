import type { RuleLayer } from "@crit/schema";
import type { RuleFile } from "./parse.ts";
import { discoverGlobalRules, discoverProjectRules, discoverUserRules } from "./sources.ts";

export * from "./parse.ts";
export * from "./select.ts";
export * from "./sources.ts";

export type DiscoverOptions = {
  root: string;
  home: string;
  /** crit's personal config folder (holds rules/ and packs). */
  configDir: string;
  include?: string[];
  sources?: RuleLayer[];
};

/** Every rule file from the three layers. */
export async function discoverRules(opts: DiscoverOptions): Promise<RuleFile[]> {
  const sources = new Set(opts.sources ?? ["project", "global", "user"]);
  return [
    ...(sources.has("project") ? await discoverProjectRules(opts.root, opts.include) : []),
    ...(sources.has("global") ? discoverGlobalRules(opts.home) : []),
    ...(sources.has("user") ? discoverUserRules(opts.configDir, opts.home) : []),
  ];
}
