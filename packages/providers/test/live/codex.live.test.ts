import { describe } from "vitest";
import { createCodexAdapter, which } from "../../src/index.ts";
import { liveReview } from "./live-helper.ts";

describe.skipIf(!(process.env.CRIT_LIVE === "1" && which("codex")))("live: codex", () => {
  liveReview((dir) =>
    createCodexAdapter(
      { name: "codex", type: "codex", command: "codex", model: null, enabled: true },
      { env: process.env, tmpDir: dir },
    ),
  );
});
