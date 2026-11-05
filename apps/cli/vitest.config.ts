import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "cli",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    exclude: ["**/*.live.test.ts"],
  },
});
