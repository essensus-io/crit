import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "store", include: ["src/**/*.test.ts", "test/**/*.test.ts"] },
});
