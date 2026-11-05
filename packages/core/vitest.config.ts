import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "core",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/*.live.test.ts"],
  },
});
