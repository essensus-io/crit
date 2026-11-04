import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: "esm",
  platform: "node",
  target: "node24",
  outDir: "dist",
  clean: true,
  // Internal workspace packages are bundled in; only third-party deps stay external.
  noExternal: [/^@crit\//],
  // Ink loads react-devtools-core only when DEV=true.
  external: ["react-devtools-core"],
  banner: { js: "#!/usr/bin/env node" },
  fixedExtension: false,
});
