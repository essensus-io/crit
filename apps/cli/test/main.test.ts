import { describe, expect, it } from "vitest";
import { main } from "../src/main.ts";

describe("crit main command", () => {
  it("is named crit and has a version", async () => {
    const meta = typeof main.meta === "function" ? await main.meta() : await main.meta;
    expect(meta?.name).toBe("crit");
    expect(meta?.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
