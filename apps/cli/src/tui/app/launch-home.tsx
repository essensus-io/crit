import { type ResolvedConfig, type ScopeSpec } from "@crit/schema";
import { type CliContext } from "../../context.ts";
import {
  type Estimate,
  HomeView,
  type HomeChoice,
  type HomeInfo,
  type RecentReview,
} from "../views/home/index.ts";
import { type Choice } from "../features/model-switching/index.ts";
import { makeSwitcher } from "./make-switcher.ts";
import { renderFullScreen } from "./render-full-screen.tsx";

/** `crit open` in a terminal: the review screen for a saved review. */
/** The start screen. Nothing runs until the user picks something and presses enter. */
export const homeTui = async (
  ctx: CliContext,
  config: ResolvedConfig,
  props: {
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
      estimate={props.estimate}
      onDone={(choice) => {
        result = choice;
      }}
    />,
  );
  return result;
};
