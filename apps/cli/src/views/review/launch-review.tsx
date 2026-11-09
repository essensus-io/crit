import { type ResolvedConfig } from "@crit/schema";
import { type SqliteStore } from "@crit/store";
import { type CliContext } from "../../context.ts";
import { ReviewView } from "./index.ts";
import { type Choice } from "../../features/model-switching/index.ts";
import { makeSession } from "./make-session.ts";
import { makeSwitcher } from "../../features/model-switching/index.ts";
import { renderFullScreen } from "../../shared/ui/index.ts";
import { summaryLine } from "../../features/review-session/index.ts";

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
