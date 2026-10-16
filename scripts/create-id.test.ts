import assert from "node:assert/strict";
import { test } from "node:test";
import { createId } from "../shared/createId.ts";

function withCrypto(provider: Partial<Crypto>, run: () => void) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: provider });
  try { run(); }
  finally { Object.defineProperty(globalThis, "crypto", descriptor); }
}

test("createId uses the native UUID generator when available", () => {
  const expected = "90d50632-c8a0-465b-98cb-5ad220762fb4";
  const provider: Partial<Crypto> = { randomUUID() { assert.equal(this, provider); return expected; } };
  withCrypto(provider, () => assert.equal(createId(), expected));
});

test("HTTP fallback sets UUID v4 version and variant bits using random bytes", () => {
  const provider = { getRandomValues<T extends ArrayBufferView | null>(bytes: T): T {
    assert.equal(this, provider);
    assert.ok(bytes instanceof Uint8Array);
    assert.equal(bytes.length, 16);
    bytes.fill(255);
    return bytes;
  } };
  withCrypto(provider, () => assert.equal(createId(), "ffffffff-ffff-4fff-bfff-ffffffffffff"));
});

test("HTTP fallback produces distinct IDs accepted by record and request validation", () => {
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  withCrypto({ getRandomValues }, () => {
    const ids = Array.from({ length: 1000 }, createId);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) {
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.match(id, /^[\w.-]{8,100}$/);
    }
  });
});
