import assert from "node:assert/strict";
import { test } from "node:test";
import {
  recommendSubjectColor,
  subjectColors,
} from "../shared/subjectColors.ts";

test("palette recommendation spreads active subjects and lets an edited subject keep its color", () => {
  assert.equal(subjectColors.length, 20);
  assert.equal(
    recommendSubjectColor([
      { id: "a", color: "blue", archived: false },
      { id: "b", color: "amber", archived: true },
    ]),
    "amber",
  );
  assert.equal(
    recommendSubjectColor(
      [{ id: "a", color: "blue", archived: false }],
      "blue",
      "a",
    ),
    "amber",
  );
});

test("manual color suggestion follows least-used colors in the cycle", () => {
  assert.equal(
    recommendSubjectColor(
      [
        { id: "a", color: "blue", archived: false },
        { id: "b", color: "amber", archived: false },
      ],
      "blue",
      undefined,
      true,
    ),
    "amber",
  );
});

test("manual color suggestion cycles through all palette colors without repeating", () => {
  const subjects: {
    id: string;
    color: (typeof subjectColors)[number]["id"];
    archived: boolean;
  }[] = [];
  let color = "blue" as (typeof subjectColors)[number]["id"];
  const seen = new Set([color]);
  for (let i = 0; i < subjectColors.length - 1; i += 1) {
    const previous = color;
    color = recommendSubjectColor(subjects, color, undefined, true);
    assert.notEqual(color, previous);
    seen.add(color);
  }
  assert.equal(seen.size, subjectColors.length);
});
