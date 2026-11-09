import { type ResolvedConfig, type ScopeSpec } from "@crit/schema";
import { type CliContext } from "../../context.ts";
import {
  type Estimate,
  HomeView,
  type HomeChoice,
  type HomeInfo,
  type RecentReview,
} from "./index.ts";
import { type Choice } from "../../features/model-switching/index.ts";
import { makeSwitcher } from "../../features/model-switching/index.ts";
import { renderFullScreen } from "../../shared/ui/index.ts";

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
