import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const versionFile = new URL(".deploy-version", root);
const validVersion = value => /^\d+\.\d+\.\d+$/.test(value);

export function cachedVersion(path = versionFile) {
  try {
    const version = readFileSync(path, "utf8").trim();
    return validVersion(version) ? version : undefined;
  } catch { return undefined; }
}

export function syncRichVersion({ path = versionFile, run = execFileSync, warn = console.warn } = {}) {
  try {
    const version = run("ssh", [
      "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "-o", "LogLevel=ERROR",
      "rich", "cat /volume1/security/docker/smena/.deploy-version",
    ], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (!validVersion(version)) throw new Error("invalid version");
    const temporary = `${fileURLToPath(new URL(path, root))}.${process.pid}.tmp`;
    writeFileSync(temporary, `${version}\n`);
    renameSync(temporary, path);
    return version;
  } catch {
    const cached = cachedVersion(path);
    warn(`Версия rich недоступна.${cached ? ` Используется сохранённая версия ${cached}.` : " Используется версия из package.json."}`);
    return cached;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = syncRichVersion();
  if (version) console.log(`Версия rich: ${version}`);
  else process.exitCode = 1;
}
