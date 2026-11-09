import type { AdapterFactory } from "../../adapter.ts";
import { codexModels } from "../../models.ts";
import { CODEX_LOGIN_HINT, createCodexAdapter } from "./codex-adapter.ts";

export const codexFactory: AdapterFactory = {
  type: "codex",
  label: "Codex",
  defaultCommand: "codex",
  defaultName: "codex",
  loginHint: CODEX_LOGIN_HINT,
  models: [],
  listModels: ({ command, env, timeoutMs }) => codexModels(command, env, timeoutMs),
  efforts: ["low", "medium", "high", "xhigh", "max"],
  defaultModelNote: "Codex built-in default; your ~/.codex/config.toml is not used",
  create: createCodexAdapter,
};
