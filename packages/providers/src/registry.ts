import { AdapterRegistry } from "./adapter.ts";
import { claudeCodeFactory } from "./adapters/claude-code.ts";
import { codexFactory } from "./adapters/codex.ts";
import { cursorFactory } from "./adapters/cursor.ts";
import { fakeFactory } from "./fake.ts";

/** The registry with every built-in adapter. */
export function createDefaultRegistry(): AdapterRegistry {
  return new AdapterRegistry()
    .register(claudeCodeFactory)
    .register(codexFactory)
    .register(cursorFactory)
    .register(fakeFactory);
}
