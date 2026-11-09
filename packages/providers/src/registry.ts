import { AdapterRegistry } from "./adapter.ts";
import { claudeCodeFactory } from "./adapters/claude-code/claude-code-factory.ts";
import { codexFactory } from "./adapters/codex/codex-factory.ts";
import { cursorFactory } from "./adapters/cursor/cursor-factory.ts";
import { fakeFactory } from "./fake.ts";

export function createDefaultRegistry(): AdapterRegistry {
  return new AdapterRegistry()
    .register(claudeCodeFactory)
    .register(codexFactory)
    .register(cursorFactory)
    .register(fakeFactory);
}
