import { type Review, shortId } from "@crit/schema";
import type { SqliteStore } from "@crit/store";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { CliError } from "@/shared/lib/errors.ts";

export async function resolveReview(
  _ctx: CliContext,
  store: SqliteStore,
  root: string,
  ref?: string,
): Promise<Review> {
  const repo = await store.repos.getByRoot(root);
  if (!ref) {
    const latest = repo ? await store.reviews.latest(repo.id) : undefined;
    if (!latest)
      throw new CliError("crit: no reviews of this repository yet", {
        hint: "Run `crit review` first.",
      });
    return latest;
  }
  let matches = await store.reviews.resolve(ref, repo?.id);
  if (matches.length === 0 && repo) matches = await store.reviews.resolve(ref);
  if (matches.length === 0)
    throw new CliError(`crit: no review matches ${ref}`, { hint: "See `crit history`." });
  if (matches.length > 1) {
    throw new CliError(`crit: ${ref} matches ${matches.length} reviews`, {
      hint: matches
        .slice(0, 5)
        .map((m) => `  ${m.id} (${shortId(m.id)}) ${m.scopeLabel}`)
        .join("\n"),
    });
  }
  return matches[0]!;
}
