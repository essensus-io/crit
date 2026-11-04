import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "cli",
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    exclude: ["**/*.live.test.ts"],
  },
});
