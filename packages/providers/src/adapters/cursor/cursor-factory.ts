import type { AdapterFactory } from "../../adapter.ts";
import { cursorModels } from "../../models.ts";
import { createCursorAdapter, CURSOR_LOGIN_HINT } from "./cursor-adapter.ts";

export const cursorFactory: AdapterFactory = {
  type: "cursor",
  label: "Cursor",
  defaultCommand: "cursor-agent",
  defaultName: "cursor",
  loginHint: CURSOR_LOGIN_HINT,
  models: [],
  listModels: ({ command, env, timeoutMs }) => cursorModels(command, env, timeoutMs),
  efforts: [],
  create: createCursorAdapter,
};
