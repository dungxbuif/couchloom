import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

export default defineConfig({
    entry: ["src/main.ts"],
    format: ["esm"],
    target: "es2022",
    platform: "node",
    outDir: "dist",
    clean: true,
    sourcemap: true,
    banner: {
        js: `#!/usr/bin/env bun
if (!("navigator" in globalThis)) globalThis.navigator = { language: "en" };`,
    },
    define: {
        "process.env.npm_package_version": JSON.stringify(pkg.version),
    },
});
