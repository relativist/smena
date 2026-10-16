import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sourceScript = fileURLToPath(new URL("./deploy-rich.sh", import.meta.url));

async function fixture(options: { health?: string; buildFail?: boolean; currentVersion?: string; deployedVersion?: string; gatewayFail?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "smena-deploy-test-"));
  const scripts = join(root, "scripts");
  await mkdir(scripts);
  await writeFile(join(root, "package.json"), '{\n  "name": "smena",\n  "version": "0.1.0"\n}\n');
  await writeFile(join(root, "docker-compose.yml"), "services:\n  smena:\n    build: .\n");
  const script = join(scripts, "deploy-rich.sh");
  await writeFile(script, await readFile(sourceScript));
  await chmod(script, 0o755);
  const fakeDocker = join(root, "docker");
  await writeFile(fakeDocker, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >>"$TEST_LOG"
if [ "$1" = compose ]; then
  shift
  first_file=
  second_file=
  [ "$1" = -f ] && { first_file=$2; shift 2; }
  [ "$1" = -f ] && { second_file=$2; shift 2; }
  case "$1" in
    ps) [ -f "$TEST_UP_MARK" ] && printf 'new-container\\n' || { [ -n "${options.currentVersion ?? ""}" ] && printf 'old-container\\n' || :; } ;;
    config) exit 0 ;;
    build) sed -n 's/^[[:space:]]*APP_VERSION: "\\([0-9.]*\\)"/\\1/p' "$second_file" >"$TEST_BUILT_VERSION"; cp "$second_file" "$TEST_OVERRIDE_CAPTURE"; [ "${options.buildFail ? "1" : "0"}" = 1 ] && exit 1 || exit 0 ;;
    up) touch "$TEST_UP_MARK" ;;
    *) exit 2 ;;
  esac
elif [ "$1" = exec ]; then
  [ "${options.gatewayFail ? "1" : "0"}" = 1 ] && exit 1
  [ "$2" = app-gateway ] && [ "$3" = nginx ] && exit 0
elif [ "$1" = inspect ]; then
  case "$3" in
    *image.version*) [ "$4" = old-container ] && printf '%s\\n' "${options.currentVersion ?? ""}" || { [ -n "${options.deployedVersion ?? ""}" ] && printf '%s\\n' "${options.deployedVersion ?? ""}" || cat "$TEST_BUILT_VERSION"; } ;;
    *Health*) printf '%s\\n' "${options.health ?? "healthy"}" ;;
    *) exit 2 ;;
  esac
else exit 2
fi
`);
  await chmod(fakeDocker, 0o755);
  return {
    root,
    state: join(root, ".deploy-version"),
    log: join(root, "docker.log"),
    lock: join(root, ".deploy-rich.lock"),
    env: {
      ...process.env,
      SMENA_DEPLOY_ROOT: root,
      SMENA_DEPLOY_COMPOSE_FILE: join(root, "docker-compose.yml"),
      SMENA_DEPLOY_DOCKER: fakeDocker,
      SMENA_DEPLOY_SUDO: "",
      SMENA_DEPLOY_HEALTH_TIMEOUT: "0",
      SMENA_DEPLOY_POLL_INTERVAL: "0",
      TEST_LOG: join(root, "docker.log"),
      TEST_UP_MARK: join(root, "up.marker"),
      TEST_BUILT_VERSION: join(root, "built-version"),
      TEST_OVERRIDE_CAPTURE: join(root, "compose-override.yml"),
    },
    script,
  };
}

function run(script: string, env: NodeJS.ProcessEnv) {
  return spawnSync(script, [], { env, encoding: "utf8" });
}

test("rich deploy increments on each successful deployment and only updates smena", async () => {
  const f = await fixture();
  try {
    const first = run(f.script, f.env);
    assert.equal(first.status, 0, first.stderr);
    assert.equal((await readFile(f.state, "utf8")).trim(), "0.1.1");
    await rm(join(f.root, "up.marker"));
    const second = run(f.script, f.env);
    assert.equal(second.status, 0, second.stderr);
    assert.equal((await readFile(f.state, "utf8")).trim(), "0.1.2");
    const commands = await readFile(f.log, "utf8");
    assert.match(commands, /build smena/);
    assert.match(commands, /up -d --no-deps --no-build smena/);
    assert.doesNotMatch(commands, /up .*smena-postgres/);
    assert.match(await readFile(join(f.root, "compose-override.yml"), "utf8"), /APP_VERSION: "0\.1\.[12]"/);
    assert.match(commands, /exec app-gateway nginx -t/);
    assert.match(commands, /exec app-gateway nginx -s reload/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("build failure does not persist a version", async () => {
  const f = await fixture({ buildFail: true });
  try {
    await writeFile(f.state, "0.1.8\n");
    const result = run(f.script, f.env);
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(f.state, "utf8"), "0.1.8\n");
    assert.doesNotMatch(await readFile(f.log, "utf8"), /up -d/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("unhealthy deploy does not persist a version", async () => {
  const f = await fixture({ health: "unhealthy" });
  try {
    const result = run(f.script, f.env);
    assert.notEqual(result.status, 0);
    await assert.rejects(readFile(f.state, "utf8"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("lock prevents a concurrent deployment", async () => {
  const f = await fixture();
  try {
    await mkdir(f.lock);
    const result = run(f.script, f.env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /another deployment is running/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("deployed image label bootstraps a missing counter", async () => {
  const f = await fixture({ currentVersion: "0.7.4" });
  try {
    const result = run(f.script, f.env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readFile(f.state, "utf8")).trim(), "0.7.5");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("an old image or gateway failure cannot be recorded as a successful deploy", async () => {
  for (const options of [{ deployedVersion: "0.1.0" }, { gatewayFail: true }]) {
    const f = await fixture(options);
    try {
      const result = run(f.script, f.env);
      assert.notEqual(result.status, 0);
      await assert.rejects(readFile(f.state, "utf8"));
      await mkdir(f.lock); // Failed deployments release their lock for a retry.
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});
