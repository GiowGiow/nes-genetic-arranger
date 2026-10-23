// @ts-check
// Tests for ui/vu-meters.js: the fitness criteria as analog VU meters. The needle's angle, the
// scale and the markup are pure and tested here; the needle's swing is CSS, seen in the browser.

import assert from "node:assert/strict";
import { test } from "node:test";

import { CRITERIA } from "../src/core/fitness.js";
import { NEEDLE_PARKED, NEEDLE_SWEEP, meterMarkup, metersMarkup, needleDegrees, readings, scaleTicks } from "../src/ui/vu-meters.js";

const weights = Object.fromEntries(CRITERIA.map((name) => [name, 1]));
const scores = {
  complementarity: 0.7071, register: 0.976, coherence: 0.958, contrast: null,
  bass_smoothness: 0.931, idiom: 0.868, fidelity: 1,
};

test("the needle sweeps from the far left at a score of 0 to the far right at 1, upright at one half", () => {
  assert.equal(needleDegrees(0), -NEEDLE_SWEEP);
  assert.equal(needleDegrees(1), NEEDLE_SWEEP);
  assert.equal(needleDegrees(0.5), 0);
});

test("a score outside 0 to 1 pins the needle at the end of the scale, as a real meter's stop does", () => {
  assert.equal(needleDegrees(-3), -NEEDLE_SWEEP);
  assert.equal(needleDegrees(7), NEEDLE_SWEEP);
});

test("a criterion with no score rests the needle beyond the zero mark, parked", () => {
  assert.equal(needleDegrees(null), NEEDLE_PARKED);
  assert.ok(NEEDLE_PARKED < -NEEDLE_SWEEP);
});

test("the scale has a tick at every quarter, from 0 to 1, along an arc above the pivot", () => {
  const ticks = scaleTicks();

  assert.deepEqual(ticks.map((tick) => tick.value), [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(ticks.filter((tick) => tick.label).map((tick) => tick.label), ["0", "1"]);
  assert.ok(ticks[0].x1 < ticks[2].x1 && ticks[2].x1 < ticks[4].x1, "left to right");
  assert.ok(ticks[2].y1 < ticks[0].y1, "the middle tick is the highest");
});

test("a reading names the criterion, the score with two decimals and the weight", () => {
  const rows = readings(scores, weights);

  assert.equal(rows.length, CRITERIA.length);
  assert.deepEqual(
    { label: rows[0].label, score: rows[0].scoreText, weight: rows[0].weightText, applies: rows[0].applies },
    { label: "Complementarity", score: "0.71", weight: "weight 1", applies: true },
  );
  assert.deepEqual(
    { score: rows[3].scoreText, applies: rows[3].applies, degrees: rows[3].degrees },
    { score: "n/a", applies: false, degrees: NEEDLE_PARKED },
  );
});

test("each meter is a figure with the meter role, its value and a sentence for a screen reader", () => {
  const [first, , , contrast] = readings(scores, weights);
  const markup = meterMarkup(first);

  assert.match(markup, /role="meter"/);
  assert.match(markup, /aria-valuemin="0"/);
  assert.match(markup, /aria-valuemax="1"/);
  assert.match(markup, /aria-valuenow="0\.71"/);
  assert.match(markup, /aria-valuetext="0\.71, weight 1"/);
  assert.match(markup, /Complementarity/);
  assert.match(markup, /<svg/);
  assert.match(markup, /aria-hidden="true"/, "the drawing is decorative: the figure carries the words");

  const none = meterMarkup(contrast);
  assert.doesNotMatch(none, /aria-valuenow/, "a criterion that does not apply has no value");
  assert.match(none, /aria-valuetext="not applicable"/);
});

test("the meters panel holds one meter per criterion, in the order of the fitness, and then the fitness itself", () => {
  const markup = metersMarkup(readings(scores, weights), 0.91);

  assert.equal(markup.match(/role="meter"/g)?.length, CRITERIA.length + 1);
  const order = [...markup.matchAll(/data-criterion="([a-z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order, [...CRITERIA, "fitness"]);
  assert.match(markup, /Fitness/);
  assert.match(markup, /0\.91/);
});

test("no emoji in the markup", () => {
  const markup = metersMarkup(readings(scores, weights), 0.91);
  assert.doesNotMatch(markup, /\p{Extended_Pictographic}/u);
});
