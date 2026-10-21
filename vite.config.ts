import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { normalizeBasePath } from "./src/basePath.js";
import { syncRichVersion } from "./scripts/local-version.mjs";

const packageVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
const appVersion = process.env.APP_VERSION ?? syncRichVersion() ?? packageVersion;
if (!/^\d+\.\d+\.\d+$/.test(appVersion)) throw new Error("APP_VERSION must have the format major.minor.patch");
const basePath = normalizeBasePath(process.env.APP_BASE_PATH);
const basePrefix = basePath === "/" ? "" : basePath.slice(0, -1);

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  base: basePath,
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      [`${basePrefix}/api`]: {
        target: `http://127.0.0.1:${process.env.SMENA_PORT ?? "3001"}`,
        changeOrigin: false,
        ...(basePrefix ? { rewrite: (path: string) => path.slice(basePrefix.length) } : {}),
      },
    },
  },
});
