// @ts-check
// Tests for ui/shelf-layout.js: where each vinyl record of a page sits and moves, and how far
// the camera stands (spec 005, story 3, research R6). The three.js scene only applies these
// numbers, so they are tested here without WebGL.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CAMERA_FOV,
  NARROW_WIDTH,
  RECORD_SPACING,
  SHELF_ROWS,
  cameraDistance,
  haloOpacity,
  perPageFor,
  recordPose,
  recordPosition,
  shelfColumns,
} from "../src/ui/shelf-layout.js";

test("a wide shelf has 5 columns, one under 560 px has 3, always 3 rows", () => {
  assert.equal(NARROW_WIDTH, 560);
  assert.equal(SHELF_ROWS, 3);
  assert.equal(shelfColumns(1200), 5);
  assert.equal(shelfColumns(560), 5);
  assert.equal(shelfColumns(559), 3);
  assert.equal(shelfColumns(375), 3);
  assert.equal(shelfColumns(0), 5, "a hidden shelf (width 0) keeps the wide layout");
  assert.equal(perPageFor(1200), 15);
  assert.equal(perPageFor(375), 9);
});

test("records fill the page row by row, centred on the middle record", () => {
  assert.equal(RECORD_SPACING, 1.7);
  assert.deepEqual(recordPosition(7, 5), { x: 0, y: 0 }, "the middle of 5×3");
  assert.deepEqual(recordPosition(0, 5), { x: -3.4, y: 1.7 }, "top left");
  assert.deepEqual(recordPosition(14, 5), { x: 3.4, y: -1.7 }, "bottom right");
  assert.deepEqual(recordPosition(4, 3), { x: 0, y: 0 }, "the middle of 3×3");
  assert.deepEqual(recordPosition(8, 3), { x: 1.7, y: -1.7 });
});

test("the camera stands far enough back to show every record, on wide and narrow stages", () => {
  const halfTan = Math.tan(((CAMERA_FOV / 2) * Math.PI) / 180);
  for (const [columns, aspect] of [[5, 760 / 400], [5, 1.2], [3, 343 / 300], [3, 0.8]]) {
    const distance = cameraDistance(columns, aspect);
    for (let index = 0; index < columns * SHELF_ROWS; index++) {
      const { x, y } = recordPosition(index, columns);
      const edge = 0.92; // radius of the selected record, the largest
      assert.ok(Math.abs(x) + edge <= halfTan * aspect * distance, `column edge of record ${index}, ${columns} columns`);
      assert.ok(Math.abs(y) + edge <= halfTan * distance, `row edge of record ${index}`);
    }
  }
});

test("the selected record comes forward, rises a little and grows; the others sit back, smaller", () => {
  const selected = recordPose(7, { selected: true, columns: 5, time: 0, reducedMotion: true });
  const other = recordPose(6, { selected: false, columns: 5, time: 0, reducedMotion: true });
  assert.deepEqual(selected, { x: 0, y: 0.12, z: 1.1, tilt: 0, spin: 0, scale: 0.92 });
  assert.deepEqual(other, { x: -1.7, y: 0, z: 0, tilt: 0.2, spin: null, scale: 0.58 });
});

test("with motion, the records bob and sway, and the selected one spins like a turntable", () => {
  const options = { columns: 5, reducedMotion: false };
  const early = recordPose(3, { ...options, selected: false, time: 1 });
  const later = recordPose(3, { ...options, selected: false, time: 2 });
  assert.notEqual(early.y, later.y, "bob");
  assert.notEqual(early.tilt, later.tilt, "sway");
  assert.equal(early.spin, null, "a record that is not selected does not spin");
  const spinning = [1, 2].map((time) => recordPose(7, { ...options, selected: true, time }).spin);
  assert.ok(Number(spinning[1]) < Number(spinning[0]), "the selected record turns on and on");
  assert.ok(Math.abs(recordPose(0, { ...options, selected: false, time: 0.3 }).y - 1.7) <= 0.05, "a gentle bob");
});

test("reduced motion: no bob, no sway, no spin, whatever the time", () => {
  for (const selected of [true, false]) {
    const poses = [0, 0.7, 3.1, 50].map((time) => recordPose(2, { selected, columns: 5, time, reducedMotion: true }));
    for (const pose of poses) assert.deepEqual(pose, poses[0]);
  }
  assert.equal(haloOpacity(0, true), haloOpacity(9, true));
  assert.notEqual(haloOpacity(0.5, false), haloOpacity(0, false), "the halo pulses with motion");
});
