import { type ResolvedConfig } from "@crit/schema";
import { type SqliteStore } from "@crit/store";
import { type CliContext } from "@/shared/lib/cli-context.ts";
import { ReviewView } from "@/views/review/review-view.tsx";
import { type Choice } from "@/features/model-switching/lib/create-switcher.ts";
import { makeSession } from "./make-session.ts";
import { makeSwitcher } from "@/features/model-switching/lib/make-switcher.ts";
import { createGithubLink } from "@/features/github-link/lib/create-github-link.ts";
import { renderFullScreen } from "@/shared/ui/render-full-screen.tsx";
import { summaryLine } from "@/features/review-session/lib/summary-line.ts";

export const openTui = async (
  ctx: CliContext,
  store: SqliteStore,
  root: string,
  reviewId: string,
  config: ResolvedConfig,
  opts: { home?: boolean } = {},
): Promise<(Choice & { fresh?: boolean }) | "home" | undefined> => {
  const review = await store.reviews.get(reviewId);
  const switcher = review ? makeSwitcher(ctx, config, { provider: review.provider }) : undefined;
  const session = await makeSession(
    ctx,
    store,
    root,
    reviewId,
    config,
    switcher ? { switcher } : {},
  );
  let rerun: (Choice & { fresh?: boolean }) | undefined;
  let wentHome = false;
  await renderFullScreen(
    <ReviewView
      session={session}
      github={createGithubLink(ctx, root)}
      {...(switcher ? { switcher } : {})}
      {...(opts.home
        ? {
            onBack: () => {
              wentHome = true;
            },
          }
        : {})}
      onRerun={(fresh) => {
        rerun = {
          ...(switcher?.current() ?? {
            provider: "",
            model: null,
            effort: null,
            depth: config.depth,
          }),
          ...(fresh ? { fresh } : {}),
        };
      }}
    />,
  );
  if (wentHome) return "home";
  if (rerun) return rerun;
  const line = await summaryLine(store, reviewId);
  if (line) ctx.out(line);
  return undefined;
};
