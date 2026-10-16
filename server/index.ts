import { resolve } from "node:path";
import { buildApp } from "./app.ts";

const app = await buildApp({ serveStatic: true, staticRoot: resolve("dist") });
const port = Number(process.env.SMENA_PORT ?? 3001);
const host = process.env.SMENA_HOST ?? "127.0.0.1";

try {
  await app.listen({ port, host });
  console.info(`Смена: http://${host}:${port}`);
} catch (error) {
  console.error(error);
  await app.close();
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => {
      process.exitCode = 0;
    });
  });
}
