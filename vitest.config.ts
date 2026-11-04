import { defineConfig } from "vitest/config";

const strict = { lines: 85, branches: 85, functions: 85, statements: 85 };

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.{ts,tsx}", "apps/*/src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "**/index.ts", "**/test/**", "**/drizzle/**"],
      reporter: ["text-summary", "text", "html"],
      thresholds: {
        "packages/core/src/**": strict,
        "packages/providers/src/**": strict,
        "packages/store/src/**": strict,
        "packages/schema/src/**": strict,
        "packages/mcp/src/**": strict,
        "apps/cli/src/**": { lines: 70, branches: 70, functions: 70, statements: 70 },
      },
    },
  },
});
