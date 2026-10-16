import test from "node:test";
import assert from "node:assert/strict";
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
