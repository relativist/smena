import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBasePath, stripBasePath, withBasePath } from "../src/basePath.js";
import { entryViewForPath, pathForView, viewForPath } from "../src/navigation.ts";

test("each app page has a stable path and maps back to its view", () => {
  for (const view of ["schedule", "catalog", "plans", "plan-coverage", "calendar", "bells", "display-settings", "teacher-load", "teacher-replacements", "schedule-print", "documentation"] as const) {
    assert.equal(viewForPath(pathForView(view)), view);
  }
});

test("public and unknown paths are not protected editor views", () => {
  assert.equal(viewForPath("/"), null);
  assert.equal(viewForPath("/students"), null);
  assert.equal(viewForPath("/teachers"), null);
  assert.equal(viewForPath("/missing"), null);
  assert.equal(viewForPath("/bells/"), "bells");
});

test("home and the student alias open the public view while editor links retain the auth shell", () => {
  for (const path of ["/", "/students", "/students/"]) assert.equal(entryViewForPath(path), "students");
  for (const path of ["/teachers", "/teachers/"]) assert.equal(entryViewForPath(path), "teachers");
  for (const path of ["/admin", "/schedule", "/catalog", "/plans", "/plan-coverage", "/calendar", "/bells", "/display-settings", "/teacher-load", "/teacher-replacements", "/schedule-print", "/documentation", "/missing"])
    assert.equal(entryViewForPath(path), "admin");
});

test("the same routes work from the root or a deployment subpath", () => {
  assert.equal(normalizeBasePath(undefined), "/");
  assert.equal(normalizeBasePath("smena"), "/smena/");
  assert.equal(normalizeBasePath("/smena/"), "/smena/");
  assert.equal(withBasePath("/"), "/");
  assert.equal(withBasePath("/api/auth/status", "/smena/"), "/smena/api/auth/status");
  assert.equal(stripBasePath("/smena", "/smena/"), "/");
  assert.equal(stripBasePath("/smena/teachers", "/smena/"), "/teachers");

  assert.equal(entryViewForPath("/smena/", "/smena/"), "students");
  assert.equal(entryViewForPath("/smena/teachers/", "/smena/"), "teachers");
  assert.equal(entryViewForPath("/smena/missing", "/smena/"), "admin");
  assert.equal(viewForPath("/smena/schedule", "/smena/"), "schedule");
  assert.equal(viewForPath("/smena/missing", "/smena/"), null);
  assert.equal(pathForView("schedule", "/smena/"), "/smena/schedule");
});
