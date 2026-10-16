import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesGroupSearch } from "../shared/groupSearch.ts";

const names = ["1А", "1Б", "10А", "11А", "11Б", "2А", "Немецкий 5А-1", "Немецкий 5А-2"];
const search = (query: string) => names.filter(name => matchesGroupSearch(name, query));

test("ordinary group search remains a case-insensitive substring search", () => {
  assert.deepEqual(search("1а"), ["1А", "11А"]);
  assert.deepEqual(search("1"), ["1А", "1Б", "10А", "11А", "11Б", "Немецкий 5А-1"]);
  assert.deepEqual(search(""), names);
});

test("strict numeric search matches the entire grade number", () => {
  assert.deepEqual(search("!1"), ["1А", "1Б"]);
  assert.deepEqual(search("!11"), ["11А", "11Б"]);
  assert.deepEqual(search("!10"), ["10А"]);
  assert.equal(matchesGroupSearch("1", "!1"), true);
  assert.equal(matchesGroupSearch("21А", "!1"), false);
});

test("strict text search matches individual names, including custom subgroup names", () => {
  assert.deepEqual(search("!1а"), ["1А"]);
  assert.deepEqual(search("!11а"), search("11а"));
  assert.deepEqual(search("  ! 1А  "), ["1А"]);
  assert.deepEqual(search("!немецкий 5а-2"), ["Немецкий 5А-2"]);
  assert.deepEqual(search("!1а, 11а"), []);
  assert.deepEqual(search("!"), names);
  assert.equal(matchesGroupSearch("1А+", "!1А+"), true);
  assert.equal(matchesGroupSearch("1А", "!1А+"), false);
});

test("preferred groups match any individual entry without matching a larger grade", () => {
  const teachers = [{ id: "first", groups: ["1А", "2Б"] }, { id: "eleventh", groups: ["11А"] }];
  const find = (query: string) => teachers.filter(teacher => teacher.groups.some(name => matchesGroupSearch(name, query))).map(teacher => teacher.id);
  assert.deepEqual(find("1а"), ["first", "eleventh"]);
  assert.deepEqual(find("!1а"), ["first"]);
  assert.deepEqual(find("!1"), ["first"]);
});
