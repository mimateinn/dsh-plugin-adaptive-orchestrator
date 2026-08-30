import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: "esm",
    dts: true,
    outDir: "lib",
    clean: true,
  },
  {
    entry: ["src/client/index.ts"],
    format: "esm",
    dts: true,
    outDir: "lib/client",
    clean: false,
  },
]);
