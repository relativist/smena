import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedVersion, syncRichVersion } from "./local-version.mjs";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "smena-local-version-"));
  const path = join(root, ".deploy-version");
  const warnings = [];
  return { path, warnings, sync: () => syncRichVersion({ path, run, warn: message => warnings.push(message) }),
    close: () => rmSync(root, { recursive: true, force: true }) };
}

test("local version reads the successful rich release and updates its cache", () => {
  const f = fixture((command, args, options) => {
    assert.equal(command, "ssh");
    assert.ok(args.includes("BatchMode=yes"));
    assert.equal(options.timeout, 5000);
    return "0.1.5\n";
  });
  try {
    writeFileSync(f.path, "0.1.4\n");
    assert.equal(f.sync(), "0.1.5");
    assert.equal(readFileSync(f.path, "utf8"), "0.1.5\n");
    assert.equal(f.warnings.length, 0);
  } finally { f.close(); }
});

test("offline rich preserves the last known version", () => {
  const f = fixture(() => { throw new Error("offline"); });
  try {
    writeFileSync(f.path, "0.1.5\n");
    assert.equal(f.sync(), "0.1.5");
    assert.match(f.warnings[0], /сохранённая версия 0.1.5/);
    assert.equal(readFileSync(f.path, "utf8"), "0.1.5\n");
  } finally { f.close(); }
});

test("invalid remote data cannot replace the cached version", () => {
  const f = fixture(() => "not a version\n");
  try {
    writeFileSync(f.path, "0.1.5\n");
    assert.equal(f.sync(), "0.1.5");
    assert.equal(readFileSync(f.path, "utf8"), "0.1.5\n");
  } finally { f.close(); }
});

test("missing or invalid cache allows the package fallback", () => {
  const f = fixture(() => { throw new Error("offline"); });
  try {
    assert.equal(f.sync(), undefined);
    writeFileSync(f.path, "broken\n");
    assert.equal(cachedVersion(f.path), undefined);
    assert.equal(f.sync(), undefined);
    assert.match(f.warnings[0], /package.json/);
  } finally { f.close(); }
});
