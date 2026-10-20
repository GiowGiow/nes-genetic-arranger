// @ts-check
// Tests for core/meter.js: a meter tells how long a bar is, where its beats fall and which beats
// are strong. They port tests/test_meter.py and check the examples of the module's doc comments.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COMMON_METERS,
  FOUR_FOUR,
  SUPPORTED_RANGE,
  barStarts,
  beatGrouping,
  beatOnsets,
  groups,
  makeMeter,
  meterText,
  parseMeter,
  strongBeats,
  strongOnsets,
  totalBeats,
} from "../src/core/meter.js";

/** @type {[string, number, number[], number[], number][]} */
const METER_CASES = [
  ["2/2", 4.0, [2.0, 2.0], [0], 16],
  ["2/4", 2.0, [1.0, 1.0], [0], 8],
  ["3/4", 3.0, [1.0, 1.0, 1.0], [0], 12],
  ["4/4", 4.0, [1.0, 1.0, 1.0, 1.0], [0, 2], 16],
  ["6/8", 3.0, [1.5, 1.5], [0], 12],
  ["9/8", 4.5, [1.5, 1.5, 1.5], [0], 18],
  ["12/8", 6.0, [1.5, 1.5, 1.5, 1.5], [0, 2], 24],
  ["5/4", 5.0, [1.0, 1.0, 1.0, 1.0, 1.0], [0, 3], 20],
  ["7/8", 3.5, [1.0, 1.0, 1.5], [0], 14],
];

for (const [text, barBeats, beats, strong, steps] of METER_CASES) {
  test(`${text} has its bar length, beats and strong beats`, () => {
    const meter = parseMeter(text);

    assert.deepEqual(
      [meter.barBeats, [...meter.beats], [...meter.strong], meter.steps],
      [barBeats, beats, strong, steps],
    );
    assert.equal(
      meter.beats.reduce((sum, beat) => sum + beat, 0),
      meter.barBeats,
    );
    assert.equal(String(meter), text);
    assert.equal(meterText(meter), text);
  });
}

test("the common meters are the nine of spec 003", () => {
  assert.deepEqual(COMMON_METERS.map(String), [
    "2/2",
    "2/4",
    "3/4",
    "4/4",
    "6/8",
    "9/8",
    "12/8",
    "5/4",
    "7/8",
  ]);
});

/** The table that spec 003 wrote by hand: [numerator, denominator, beats, strong beats]. */
const SPEC_003_TABLE = [
  [2, 2, [2.0, 2.0], [0]],
  [2, 4, [1.0, 1.0], [0]],
  [3, 4, [1.0, 1.0, 1.0], [0]],
  [4, 4, [1.0, 1.0, 1.0, 1.0], [0, 2]],
  [6, 8, [1.5, 1.5], [0]],
  [9, 8, [1.5, 1.5, 1.5], [0]],
  [12, 8, [1.5, 1.5, 1.5, 1.5], [0, 2]],
  [5, 4, [1.0, 1.0, 1.0, 1.0, 1.0], [0, 3]],
  [7, 8, [1.0, 1.0, 1.5], [0]],
];

test("the rule derives exactly the table of spec 003 for the nine common meters", () => {
  const derived = COMMON_METERS.map((meter) => [
    meter.numerator,
    meter.denominator,
    [...meter.beats],
    [...meter.strong],
  ]);

  assert.deepEqual(derived, SPEC_003_TABLE);
});

/** @type {[string, number[], number[]][]} */
const RULE_CASES = [
  // Simple: n beats of the denominator note.
  ["3/2", [2, 2, 2], [0]],
  ["3/8", [0.5, 0.5, 0.5], [0]],
  ["7/4", Array(7).fill(1), [0, 4]],
  ["1/4", [1], [0]],
  ["4/1", [4, 4, 4, 4], [0, 2]],
  ["4/8", [0.5, 0.5, 0.5, 0.5], [0, 2]],
  ["2/8", [0.5, 0.5], [0]],
  // Compound: a multiple of 3, from 6 on, in beats of three denominator notes.
  ["6/4", [3, 3], [0]],
  ["12/16", [0.75, 0.75, 0.75, 0.75], [0, 2]],
  ["9/16", [0.75, 0.75, 0.75], [0]],
  // Irregular fast: eighths or sixteenths in twos, and a last three when n is odd.
  ["5/8", [1, 1.5], [0]],
  ["8/8", [1, 1, 1, 1], [0, 2]],
  ["11/8", [1, 1, 1, 1, 1.5], [0, 3]],
  ["7/16", [0.5, 0.5, 0.75], [0]],
];

for (const [text, beats, strong] of RULE_CASES) {
  test(`the rule gives ${text} its beats and strong beats`, () => {
    const meter = parseMeter(text);
    const [numerator, denominator] = text.split("/").map(Number);

    assert.deepEqual([[...meter.beats], [...meter.strong]], [beats, strong]);
    assert.equal(
      meter.beats.reduce((sum, beat) => sum + beat, 0),
      meter.barBeats,
    );
    assert.equal(meter.steps, (16 * numerator) / denominator);
    assert.equal(String(meter), text);
  });
}

test("the notes of a bar gather into beats by the rule: threes, twos with a last three, or ones", () => {
  assert.deepEqual(
    [beatGrouping(6, 8), beatGrouping(7, 8), beatGrouping(11, 8), beatGrouping(3, 4)],
    [[3, 3], [2, 2, 3], [2, 2, 2, 2, 3], [1, 1, 1]],
  );
});

for (const [beatCount, strong] of [
  [1, [0]],
  [2, [0]],
  [3, [0]],
  [4, [0, 2]],
  [5, [0, 3]],
  [6, [0, 3]],
  [7, [0, 4]],
]) {
  test(`${beatCount} beats have the strong beats ${strong} (the first and the middle one from 4 beats on)`, () => {
    assert.deepEqual(strongBeats(/** @type {number} */ (beatCount)), strong);
  });
}

/** @type {[string, string, number[], number[]][]} */
const ADDITIVE_CASES = [
  ["2+2+3/8", "2+2+3/8", [1, 1, 1.5], [0]],
  ["(3+3+2)/8", "3+3+2/8", [1.5, 1.5, 1], [0]],
  ["3+2/4", "3+2/4", [3, 2], [0]],
  ["2+2+2+3/8", "2+2+2+3/8", [1, 1, 1, 1.5], [0, 2]],
];

for (const [text, written, beats, strong] of ADDITIVE_CASES) {
  test(`the additive meter ${text} has one beat per group`, () => {
    const meter = parseMeter(text);

    assert.deepEqual([[...meter.beats], [...meter.strong]], [beats, strong]);
    assert.equal(meter.numerator, /** @type {readonly number[]} */ (meter.grouping).reduce((sum, group) => sum + group, 0));
    assert.equal(meter.barBeats, beats.reduce((sum, beat) => sum + beat, 0));
    assert.equal(String(meter), written);
    assert.equal(meterText(meter), written);
    assert.equal(parseMeter(written), meter);
  });
}

test("an additive meter keeps its grouping apart from the plain meter", () => {
  const additive = parseMeter("2+2+3/8");

  assert.notEqual(additive, makeMeter(7, 8));
  assert.equal(makeMeter(7, 8, [2, 2, 3]), additive);
  assert.equal(makeMeter(7, 8).grouping, null);
  assert.deepEqual([...parseMeter("3+2+2/8").beats], [1.5, 1, 1]);
});

test("a grouping must add up to the numerator and have two groups or more", () => {
  assert.throws(() => makeMeter(7, 8, [2, 2]), {
    message: "the groups 2+2 do not make an additive meter of 7/8: it needs two or more groups that add up to 7",
  });
  assert.throws(() => makeMeter(7, 8, [7]), /do not make an additive meter/);
  assert.throws(() => makeMeter(7, 8, [4, 0, 3]), /do not make an additive meter/);
});

test("a meter and its lists of beats cannot be changed", () => {
  for (const meter of [...COMMON_METERS, parseMeter("11/8"), parseMeter("2+2+3/8")]) {
    assert.ok(Object.isFrozen(meter));
    assert.ok(Object.isFrozen(meter.beats));
    assert.ok(Object.isFrozen(meter.strong));
  }
  assert.ok(Object.isFrozen(COMMON_METERS));
  assert.ok(Object.isFrozen(/** @type {readonly number[]} */ (parseMeter("2+2+3/8").grouping)));
});

test("the same meter is always the same object, so meters compare with ===", () => {
  assert.equal(makeMeter(3, 4), makeMeter(3, 4));
  assert.equal(parseMeter("6/8"), makeMeter(6, 8));
  assert.equal(COMMON_METERS[2], makeMeter(3, 4));
  assert.equal(parseMeter("3/2"), makeMeter(3, 2));
  assert.equal(parseMeter("(3+3+2)/8"), parseMeter("3+3+2/8"));
});

test("common time is four four and cut time is two two", () => {
  assert.equal(parseMeter("C"), FOUR_FOUR);
  assert.equal(FOUR_FOUR, makeMeter(4, 4));
  assert.equal(parseMeter("C|"), makeMeter(2, 2));
});

test("spaces around the meter are ignored", () => {
  assert.equal(parseMeter(" 3/4 "), makeMeter(3, 4));
});

for (const text of ["3/32", "33/8", "none", "3/5", "0/4", "4", "3/0", "2+0+3/8", "(3+2/8", "2+2+3/32", "x/4"]) {
  test(`the meter "${text}" is refused, naming the meter, the bar and the range`, () => {
    assert.throws(() => parseMeter(text, 5), {
      name: "Error",
      message: `bar 5: the meter ${text} is not supported; supported meters: ${SUPPORTED_RANGE}`,
    });
  });
}

test("the range message is the one of the Python reader", () => {
  assert.equal(
    SUPPORTED_RANGE,
    "n/d with n from 1 to 32 and d = 1, 2, 4, 8 or 16, additive meters such as 2+2+3/8, C and C|",
  );
});

test("without a bar number the message names only the meter", () => {
  assert.throws(() => parseMeter("3/32"), {
    message: `the meter 3/32 is not supported; supported meters: ${SUPPORTED_RANGE}`,
  });
});

for (const [numerator, denominator] of [
  [3, 32],
  [33, 8],
  [0, 4],
  [3, 6],
  [2.5, 4],
]) {
  test(`constructing the meter ${numerator}/${denominator} directly is refused`, () => {
    assert.throws(() => makeMeter(numerator, denominator), {
      message: new RegExp(`^the meter ${numerator}/${denominator} is not supported`),
    });
  });
}

test("the limits of the range are accepted", () => {
  assert.deepEqual(["1/1", "32/16", "32/1", "1/16"].map((text) => String(parseMeter(text))), [
    "1/1",
    "32/16",
    "32/1",
    "1/16",
  ]);
  assert.equal(parseMeter("32/16").steps, 32);
});

test("beat and strong onsets are running sums of the beats", () => {
  assert.deepEqual(beatOnsets(FOUR_FOUR), [0.0, 1.0, 2.0, 3.0]);
  assert.deepEqual(strongOnsets(FOUR_FOUR), [0.0, 2.0]);
  const seven = parseMeter("7/8");
  assert.deepEqual(beatOnsets(seven), [0.0, 1.0, 2.0]);
  assert.deepEqual(strongOnsets(seven), [0.0]);
  assert.deepEqual(strongOnsets(parseMeter("12/8")), [0.0, 3.0]);
  assert.deepEqual(strongOnsets(parseMeter("5/4")), [0.0, 3.0]);
});

test("groups run from one strong beat to the next", () => {
  assert.deepEqual(groups(FOUR_FOUR), [
    [0.0, 2.0],
    [2.0, 2.0],
  ]);
  assert.deepEqual(groups(parseMeter("5/4")), [
    [0.0, 3.0],
    [3.0, 2.0],
  ]);
  assert.deepEqual(groups(parseMeter("3/4")), [[0.0, 3.0]]);
  assert.deepEqual(groups(parseMeter("12/8")), [
    [0.0, 3.0],
    [3.0, 3.0],
  ]);
});

test("bar starts add up the lengths of the bars before", () => {
  const bars = [{ meter: FOUR_FOUR }, { meter: parseMeter("2/4") }, { meter: parseMeter("3/4") }];

  assert.deepEqual(barStarts(bars), [0.0, 4.0, 6.0]);
  assert.equal(totalBeats(bars), 9.0);
});

test("a piece of two 6/8 bars lasts six quarter notes", () => {
  assert.equal(totalBeats([{ meter: parseMeter("6/8") }, { meter: parseMeter("6/8") }]), 6.0);
});

test("a piece without bars has no bar starts and lasts zero beats", () => {
  assert.deepEqual(barStarts([]), []);
  assert.equal(totalBeats([]), 0);
});

test("a meter survives a structured clone, so a lead sheet can be posted to the worker", () => {
  const clone = structuredClone(makeMeter(3, 4));

  assert.deepEqual(
    [clone.numerator, clone.denominator, clone.barBeats, [...clone.beats], [...clone.strong], clone.steps],
    [3, 4, 3, [1, 1, 1], [0], 12],
  );
  assert.equal(meterText(clone), "3/4");
});

test("an additive meter survives a structured clone with its grouping and no function", () => {
  const clone = structuredClone(parseMeter("2+2+3/8"));

  assert.deepEqual([clone.numerator, clone.denominator, [...(clone.grouping ?? [])]], [7, 8, [2, 2, 3]]);
  assert.deepEqual(Object.keys(clone).sort(), Object.keys(parseMeter("2+2+3/8")).sort());
  assert.equal(meterText(clone), "2+2+3/8");
});

test("groups of the new meters run from one strong beat to the next", () => {
  assert.deepEqual(groups(parseMeter("11/8")), [
    [0.0, 3.0],
    [3.0, 2.5],
  ]);
  assert.deepEqual(groups(parseMeter("3/2")), [[0.0, 6.0]]);
  assert.deepEqual(strongOnsets(parseMeter("2+2+2+3/8")), [0.0, 2.0]);
  assert.deepEqual(beatOnsets(parseMeter("2+2+3/8")), [0.0, 1.0, 2.0]);
});
