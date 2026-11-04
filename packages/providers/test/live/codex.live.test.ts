/** Live smoke test through the real Codex CLI. Opt-in: `pnpm test:live`. Never in CI. */
import { describe } from "vitest";
import { CodexAdapter, which } from "../../src/index.ts";
import { liveReview } from "./live-helper.ts";

describe.skipIf(!(process.env.CRIT_LIVE === "1" && which("codex")))("live: codex", () => {
  liveReview(
    (dir) =>
      new CodexAdapter(
        { name: "codex", type: "codex", command: "codex", model: null, enabled: true },
        { env: process.env, tmpDir: dir },
      ),
  );
});
