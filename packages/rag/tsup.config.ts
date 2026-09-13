import { defineConfig } from "tsup";

export default defineConfig({ entry: ["src/index.ts"], format: ["esm"], target: "es2022", platform: "node", dts: true, clean: true, sourcemap: true });
