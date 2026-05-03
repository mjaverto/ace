import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    target: "node20",
    splitting: false,
    sourcemap: true,
    shims: false,
  },
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    dts: true,
    clean: false,
    target: "node20",
    splitting: false,
    sourcemap: true,
    shims: false,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
]);
