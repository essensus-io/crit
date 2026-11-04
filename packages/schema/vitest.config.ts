import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "schema", include: ["src/**/*.test.ts", "test/**/*.test.ts"] },
});
