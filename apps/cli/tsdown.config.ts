import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: "esm",
  platform: "node",
  target: "node24",
  outDir: "dist",
  clean: true,
  noExternal: [/^@crit\//],
  external: ["react-devtools-core"],
  banner: { js: "#!/usr/bin/env node" },
  fixedExtension: false,
});
