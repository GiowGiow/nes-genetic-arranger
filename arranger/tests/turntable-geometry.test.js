// @ts-check
// Tests for ui/turntable-geometry.js: the numbers of the result turntable. The tonearm is a real
// pivoting arm, so its angle comes from the geometry of the arm and the groove, not from a
// straight line; these tests pin that geometry, the spin that eases, and the drag that seeks.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ARM_LENGTH,
  ARM_PIVOT,
  GROOVE_INNER,
  GROOVE_OUTER,
  PLATTER_SPEED,
  REST_PROGRESS,
  armAngleForProgress,
  armTip,
  approach,
  armValueText,
  cameraDistance,
  needleRadius,
  pickTarget,
  progressForArmAngle,
  progressForPoint,
  stepSpin,
} from "../src/ui/turntable-geometry.js";

const close = (/** @type {number} */ a, /** @type {number} */ b, tolerance = 1e-9) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${a} is not within ${tolerance} of ${b}`);

test("the platter turns at 33 and a third revolutions a minute", () => {
  close(PLATTER_SPEED, ((100 / 3) * 2 * Math.PI) / 60);
});

test("the needle starts in the outer groove and ends in the inner one, moving inward in a straight line of time", () => {
  assert.equal(needleRadius(0), GROOVE_OUTER);
  assert.equal(needleRadius(1), GROOVE_INNER);
  close(needleRadius(0.5), (GROOVE_OUTER + GROOVE_INNER) / 2);
  assert.ok(needleRadius(REST_PROGRESS) > GROOVE_OUTER, "parked, the needle is beyond the record's edge");
});

test("the arm's tip lands on the groove radius it should: the angle comes from the arm's geometry", () => {
  for (const progress of [REST_PROGRESS, 0, 0.25, 0.5, 0.75, 1]) {
    const tip = armTip(armAngleForProgress(progress));
    close(Math.hypot(tip.x, tip.z), needleRadius(progress), 1e-9);
  }
});

test("the arm swings across the record: its angle grows steadily with progress, the tip going toward the spindle", () => {
  let previous = armAngleForProgress(REST_PROGRESS);
  for (let step = 0; step <= 10; step += 1) {
    const angle = armAngleForProgress(step / 10);
    assert.ok(angle > previous, `step ${step}`);
    previous = angle;
  }
});

test("the arm is longer than the distance it needs, so it reaches every groove from its pivot", () => {
  const distance = Math.hypot(ARM_PIVOT.x, ARM_PIVOT.z);
  assert.ok(ARM_LENGTH > distance - GROOVE_INNER, "reaches the inner groove");
  assert.ok(ARM_LENGTH < distance + GROOVE_INNER, "does not need to fold");
});

test("the progress read back from an arm angle is the progress that made the angle", () => {
  for (const progress of [0, 0.1, 0.5, 0.9, 1]) {
    close(progressForArmAngle(armAngleForProgress(progress)), progress, 1e-9);
  }
});

test("an arm angle beyond the ends clamps to the start or the end of the song", () => {
  assert.equal(progressForArmAngle(armAngleForProgress(REST_PROGRESS)), 0);
  assert.equal(progressForArmAngle(armAngleForProgress(1.4)), 1);
});

test("a point dragged on the platter aims the arm: the progress is where the arm pointing at the point would drop its needle", () => {
  const tip = armTip(armAngleForProgress(0.3));
  // Any point on the line from the pivot through that tip, near or far, aims the arm the same way.
  const toward = { x: ARM_PIVOT.x + (tip.x - ARM_PIVOT.x) * 1.7, z: ARM_PIVOT.z + (tip.z - ARM_PIVOT.z) * 1.7 };
  close(progressForPoint(toward), 0.3, 1e-9);
  close(progressForPoint(tip), 0.3, 1e-9);
});

test("a drag far past the record on either side stays between the start and the end", () => {
  const off = progressForPoint({ x: 5, z: 5 });
  assert.ok(off >= 0 && off <= 1);
  const other = progressForPoint({ x: -5, z: -5 });
  assert.ok(other >= 0 && other <= 1);
});

test("the spin eases up to speed when playing and eases to a stop when paused", () => {
  let spin = { angle: 0, speed: 0 };
  for (let frame = 0; frame < 60; frame += 1) spin = stepSpin(spin, 1 / 30, true);
  close(spin.speed, PLATTER_SPEED, PLATTER_SPEED * 0.01);
  assert.ok(spin.angle > 0);

  const halfway = stepSpin({ angle: 0, speed: 0 }, 0.1, true);
  assert.ok(halfway.speed > 0 && halfway.speed < PLATTER_SPEED, "it does not jump to full speed");

  let slowing = { angle: spin.angle, speed: spin.speed };
  let turned = 0;
  for (let frame = 0; frame < 150; frame += 1) {
    const next = stepSpin(slowing, 1 / 30, false);
    assert.ok(next.speed <= slowing.speed, "it never speeds up while pausing");
    // The angle wraps at a full turn, so the gain is the difference modulo a turn.
    turned += (next.angle - slowing.angle + Math.PI * 2) % (Math.PI * 2);
    slowing = next;
  }
  assert.ok(slowing.speed < 0.01, "it has stopped after five seconds");
  assert.ok(turned > 0, "it kept turning while it slowed");
  assert.ok(turned < Math.PI * 2, "it coasts less than a turn");
});

test("the spin angle stays within one turn so a long visit never loses precision", () => {
  let spin = { angle: 0, speed: PLATTER_SPEED };
  for (let frame = 0; frame < 3000; frame += 1) spin = stepSpin(spin, 1 / 30, true);
  assert.ok(spin.angle >= 0 && spin.angle < Math.PI * 2);
});

test("a long pause between frames (a hidden tab coming back) does not spin the record wildly", () => {
  const spin = stepSpin({ angle: 0, speed: PLATTER_SPEED }, 60, true);
  assert.ok(spin.angle < Math.PI * 2);
  close(spin.speed, PLATTER_SPEED, PLATTER_SPEED * 0.01);
});

test("the arm's value text says the time and the length, for a screen reader", () => {
  assert.equal(armValueText(12.4, 51), "0:12 of 0:51");
  assert.equal(armValueText(0, 0), "No song loaded");
  assert.equal(armValueText(61, 185), "1:01 of 3:05");
});

test("a press near the needle or on the arm grabs the arm; a press on the record grabs the record; elsewhere grabs nothing", () => {
  const angle = armAngleForProgress(0.4);
  const tip = armTip(angle);
  assert.equal(pickTarget({ x: tip.x + 0.05, z: tip.z }, angle), "arm", "at the needle");
  const along = { x: ARM_PIVOT.x + (tip.x - ARM_PIVOT.x) * 0.6, z: ARM_PIVOT.z + (tip.z - ARM_PIVOT.z) * 0.6 };
  assert.equal(pickTarget(along, angle), "arm", "on the arm's tube");
  assert.equal(pickTarget({ x: 0, z: 0.2 }, angle), "record");
  assert.equal(pickTarget({ x: -2, z: 1.2 }, angle), null);
});

test("a value approaches its target exponentially, never overshooting, and a long step lands on it", () => {
  const halfway = approach(0, 1, 0.1, 0.1);
  assert.ok(halfway > 0.6 && halfway < 0.65, "one time constant covers 63 percent");
  assert.ok(approach(0, 1, 100, 0.1) > 0.999);
  assert.equal(approach(0.5, 0.5, 1, 0.1), 0.5);
  assert.ok(approach(1, 0, 0.05, 0.1) > 0, "it comes down from above too");
});

test("the camera stands far enough back to keep the whole turntable in view, farther for a narrow stage", () => {
  const wide = cameraDistance(1.6);
  const normal = cameraDistance(1.16);
  const narrow = cameraDistance(0.7);

  assert.ok(narrow > normal && normal > wide, "a narrower stage needs more distance to fit the width");
  assert.ok(wide >= 5.0, "never closer than what fits the plinth's depth");
  // At that distance the stage's width, in scene units on the view plane, holds the plinth (3.2 wide, and more for the near edge).
  for (const aspect of [0.7, 1.16, 1.6]) assert.ok(cameraDistance(aspect) * 2 * Math.tan((17 * Math.PI) / 180) * aspect >= 4.1 - 1e-9, `aspect ${aspect}`);
});
