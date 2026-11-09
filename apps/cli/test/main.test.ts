import { describe, expect, it } from "vitest";
import { createMain, VERSION } from "../src/app/main.ts";
import { testContext } from "./helpers.ts";

describe("crit main command", () => {
  it("is named crit and has a version", async () => {
    const { ctx } = testContext();
    const main = createMain(ctx);
    const meta = typeof main.meta === "function" ? await main.meta() : await main.meta;
    expect(meta?.name).toBe("crit");
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
