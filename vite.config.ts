import { defineConfig } from "vite";
import { normalizeBasePath } from "./src/basePath.js";

const basePath = normalizeBasePath(process.env.APP_BASE_PATH);
const basePrefix = basePath === "/" ? "" : basePath.slice(0, -1);

export default defineConfig({
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
