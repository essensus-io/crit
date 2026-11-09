import { z } from "zod";
import { readAtRevision } from "./intake.ts";
import { sha256 } from "./sha256.ts";
import { depthProfile } from "./shards.ts";
import type { Prepared, ReviewOptions } from "./review-types.ts";

export const CachedFile = z.object({ findings: z.array(z.unknown()) });

export const fileCacheKey = (parts: unknown[]) =>
  `file:${sha256(JSON.stringify(["v2-skeptical-prompt", ...parts]))}`;

export const cacheKeyFor = async (
  prepared: Prepared,
  options: ReviewOptions,
  path: string,
): Promise<string> => {
  const file = prepared.scope.files.find((candidate) => candidate.path === path);
  return fileCacheKey([
    path,
    sha256((await readAtRevision(prepared.scope, path)) ?? ""),
    file?.hunks ?? null,
    prepared.rulesHash,
    depthProfile(options.config).lenses,
    options.provider.profile.type,
    options.provider.profile.name,
    options.provider.profile.model,
  ]);
};
