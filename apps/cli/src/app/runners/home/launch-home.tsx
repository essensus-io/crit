import { type ResolvedConfig, type ScopeSpec } from "@crit/schema";
import { type CliContext } from "@/shared/lib/cli-context.ts";
import {
  type Estimate,
  HomeView,
  type HomeChoice,
  type HomeInfo,
  type RecentReview,
} from "@/views/home/home-view.tsx";
import { type Choice } from "@/features/model-switching/lib/create-switcher.ts";
import { makeSwitcher } from "@/features/model-switching/lib/make-switcher.ts";
import { createGithubLink } from "@/features/github-link/lib/create-github-link.ts";
import { renderFullScreen } from "@/shared/ui/render-full-screen.tsx";

export const homeTui = async (
  ctx: CliContext,
  config: ResolvedConfig,
  props: {
    root: string;
    info: HomeInfo;
    bases?: { ref: string; ahead: number }[];
    recent: RecentReview[];
    initialSpec?: ScopeSpec;
    initialChoice: Partial<Choice> & { provider: string };
    estimate: (spec: ScopeSpec) => Promise<Estimate>;
  },
): Promise<HomeChoice> => {
  let result: HomeChoice = { kind: "quit" };
  const switcher = makeSwitcher(ctx, config, props.initialChoice);
  await renderFullScreen(
    <HomeView
      info={props.info}
      bases={props.bases ?? []}
      recent={props.recent}
      initialSpec={props.initialSpec}
      switcher={switcher}
      github={createGithubLink(ctx, props.root)}
      estimate={props.estimate}
      onDone={(choice) => {
        result = choice;
      }}
    />,
  );
  return result;
};
