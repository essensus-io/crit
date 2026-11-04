/** Live smoke test through the real Claude Code CLI. Opt-in: `pnpm test:live`. Never in CI. */
import { describe } from "vitest";
import { ClaudeCodeAdapter, which } from "../../src/index.ts";
import { liveReview } from "./live-helper.ts";

describe.skipIf(!(process.env.CRIT_LIVE === "1" && which("claude")))("live: claude-code", () => {
  liveReview(
    (dir) =>
      new ClaudeCodeAdapter(
        { name: "claude", type: "claude-code", command: "claude", model: "haiku", enabled: true },
        { env: process.env, tmpDir: dir },
      ),
  );
});
