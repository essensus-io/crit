import { AdapterRegistry } from "./adapter.ts";
import { claudeCodeFactory } from "./adapters/claude-code.ts";
import { fakeFactory } from "./fake.ts";

/** The registry with every built-in adapter. */
export function createDefaultRegistry(): AdapterRegistry {
  return new AdapterRegistry().register(claudeCodeFactory).register(fakeFactory);
}
