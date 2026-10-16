import assert from "node:assert/strict";
import { schoolSubjectPresets } from "../shared/schoolSubjects.ts";
import {
  isSubjectIconId,
  resolveSubjectIconId,
  subjectIcons,
} from "../shared/subjectIcons.ts";

assert.equal(subjectIcons.length, 26);
assert.ok(isSubjectIconId("flag-uk"));
assert.ok(!isSubjectIconId("auto"));
assert.ok(!isSubjectIconId("unknown"));

for (const preset of schoolSubjectPresets) {
  assert.notEqual(resolveSubjectIconId({ id: preset.id, name: preset.name }), null, preset.name);
}

assert.equal(resolveSubjectIconId({ id: "english", name: "Custom label" }), "flag-uk");
assert.equal(resolveSubjectIconId({ name: "АНГЛ.   ЯЗ!" }), "flag-uk");
assert.equal(resolveSubjectIconId({ name: "Физ–ра" }), "sport");
assert.equal(resolveSubjectIconId({ name: "Иностранный язык" }), "book");
assert.equal(resolveSubjectIconId({ name: "Неизвестный предмет" }), "book");
assert.equal(resolveSubjectIconId({ name: "Математика", iconId: "flag-cn" }), "flag-cn");
assert.equal(resolveSubjectIconId({ id: "english", name: "English", iconId: "auto" }), "flag-uk");
assert.equal(resolveSubjectIconId({ id: "english", name: "English", iconId: null }), null);

console.log(`subject icon checks passed (${subjectIcons.length} icon choices, ${schoolSubjectPresets.length} presets)`);
