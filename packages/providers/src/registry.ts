import { AdapterRegistry } from "./adapter.ts";
import { fakeFactory } from "./fake.ts";

/** The registry with every built-in adapter. */
export function createDefaultRegistry(): AdapterRegistry {
  return new AdapterRegistry().register(fakeFactory);
}
