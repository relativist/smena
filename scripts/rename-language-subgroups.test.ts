import assert from "node:assert/strict";
import { buildRenamePlan } from "./rename-language-subgroups.ts";

const input = [
  { id: "sg-de-2", group_id: "g1", group_name: "5А", name: "Немецкий язык", subject_id: "school:german" },
  { id: "sg-de-1", group_id: "g1", group_name: "5А", name: "Немецкий язык", subject_id: "school:german" },
  { id: "sg-zh", group_id: "g1", group_name: "5А", name: "Китайский язык", subject_id: "school:chinese" },
];
const plan = buildRenamePlan(input);
assert.deepEqual(Object.fromEntries(plan.map(row => [row.id, row.newName])), {
  "sg-de-1": "Немецкий 5А-1",
  "sg-de-2": "Немецкий 5А-2",
  "sg-zh": "Китайский 5А",
});
const alreadyRenamed = buildRenamePlan(plan.map(row => ({
  id: row.id,
  group_id: row.groupId,
  group_name: "5А",
  name: row.newName,
  subject_id: row.subjectId,
})));
assert.equal(alreadyRenamed.every(row => row.oldName === row.newName), true);
console.log("Language subgroup rename tests passed");
