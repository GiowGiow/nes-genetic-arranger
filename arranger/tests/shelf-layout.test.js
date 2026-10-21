// @ts-check
// Tests for ui/shelf-layout.js: where each vinyl record of a page sits and moves, and how far
// the camera stands (spec 005, story 3, research R6). The three.js scene only applies these
// numbers, so they are tested here without WebGL.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CAMERA_FOV,
  HALO_SCALE,
  MARQUEE_GAP,
  MARQUEE_PAUSE,
  MARQUEE_SPEED,
  MARQUEE_STAGGER,
  NARROW_WIDTH,
  RECORD_SPACING,
  SHELF_ROWS,
  STRIP_HEIGHT,
  STRIP_PADDING,
  STRIP_PIXELS,
  STRIP_WIDTH,
  cameraDistance,
  ellipsize,
  haloOpacity,
  isLowPower,
  marqueeCycle,
  marqueeOffset,
  perPageFor,
  pixelRatioFor,
  recordPose,
  recordPosition,
  scaleEasing,
  shelfColumns,
  shouldRenderFrame,
  stripOpacity,
  stripY,
  targetFps,
  titleNeedsScroll,
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

test("the glow of the selected record fits the stage whichever record is selected, so it is never cut off", () => {
  const halfTan = Math.tan(((CAMERA_FOV / 2) * Math.PI) / 180);
  const haloPlane = 1.1 - 0.3; // the glow sits 0.3 behind the selected record, which is 1.1 forward
  for (const [columns, aspect] of [[5, 760 / 400], [5, 1.2], [3, 343 / 300], [3, 0.8]]) {
    const distance = cameraDistance(columns, aspect);
    for (let index = 0; index < columns * SHELF_ROWS; index++) {
      const { x, y } = recordPosition(index, columns);
      const reach = HALO_SCALE / 2;
      assert.ok(Math.abs(x) + reach <= halfTan * aspect * (distance - haloPlane), `glow width at record ${index}, ${columns} columns`);
      assert.ok(Math.abs(y) + 0.17 + reach <= halfTan * (distance - haloPlane), `glow height at record ${index}`);
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

test("the selected record sways only a little, so the disc never swings deep behind the glow", () => {
  let widest = 0;
  for (let time = 0; time < 20; time += 0.1) {
    const { tilt } = recordPose(7, { selected: true, columns: 5, time, reducedMotion: false });
    widest = Math.max(widest, Math.abs(tilt));
  }
  assert.ok(widest > 0.2, "it still sways");
  assert.ok(widest <= 0.35, `the widest sway is ${widest} rad`);
  // The glow sits 0.3 behind the record's centre: the disc's far edge stays in front of it
  assert.ok(0.92 * Math.sin(widest) < 0.3);
});

// ---- Title strips under the records ----------------------------------------------------------

test("a title strip is narrower than the gap between record centres and keeps its texture's proportions", () => {
  assert.ok(STRIP_WIDTH < RECORD_SPACING, "neighbouring strips never touch");
  assert.ok(Math.abs(STRIP_HEIGHT / STRIP_WIDTH - STRIP_PIXELS.height / STRIP_PIXELS.width) < 1e-9, "texels stay square");
  assert.ok(STRIP_PADDING * 2 < STRIP_PIXELS.width);
});

test("the strip hangs just below its record, wherever the record is and however big", () => {
  const resting = stripY(0, 0.58);
  const selected = stripY(0.12, 0.92);
  assert.ok(resting < -0.58, "below a resting record's rim");
  assert.ok(selected < 0.12 - 0.92, "below the selected record's rim, which is larger");
  assert.ok(resting - STRIP_HEIGHT / 2 > -1.7 + 0.58 + 0.05, "clear of the next row's resting record, bob included");
});

test("a title scrolls only when its text is wider than the strip's room for it", () => {
  const room = STRIP_PIXELS.width - 2 * STRIP_PADDING;
  assert.equal(titleNeedsScroll(room), false, "an exact fit stays still");
  assert.equal(titleNeedsScroll(room + 1), true);
  assert.equal(titleNeedsScroll(20), false);
});

test("the marquee waits at the start, then moves at a steady speed, and a whole cycle looks like the start", () => {
  assert.equal(MARQUEE_SPEED > 0 && MARQUEE_SPEED < 40, true, "slow");
  const cycle = marqueeCycle(300);
  assert.equal(cycle, 300 + MARQUEE_GAP, "the text, a gap, and then the text again");
  assert.equal(marqueeOffset(0, cycle), 0);
  assert.equal(marqueeOffset(MARQUEE_PAUSE * 0.99, cycle), 0, "waits so the title can be read from its start");
  assert.ok(Math.abs(marqueeOffset(MARQUEE_PAUSE + 1, cycle) - MARQUEE_SPEED) < 1e-9, "one second after the wait");
  const period = MARQUEE_PAUSE + cycle / MARQUEE_SPEED;
  assert.ok(marqueeOffset(period - 0.001, cycle) < cycle, "never passes one cycle");
  assert.ok(marqueeOffset(period + 0.5, cycle) === 0, "starts over");
  assert.ok(Math.abs(marqueeOffset(3 * period + MARQUEE_PAUSE + 2, cycle) - 2 * MARQUEE_SPEED) < 1e-6, "every cycle alike");
  assert.ok(MARQUEE_STAGGER > 0 && MARQUEE_STAGGER < MARQUEE_PAUSE, "neighbours start a little apart");
  assert.equal(marqueeOffset(-5, cycle) >= 0, true, "a time before the start still gives an offset in range");
});

test("ellipsize cuts a title to fit, ending with an ellipsis, and leaves a fitting title alone", () => {
  const measure = (/** @type {string} */ text) => text.length * 5; // a monospace font, 5 px a letter
  assert.equal(ellipsize("Ievan Polkka", 100, measure), "Ievan Polkka");
  const cut = ellipsize("Korobeiniki (Tetris Theme A)", 60, measure);
  assert.ok(cut.endsWith("…"));
  assert.ok(measure(cut) <= 60, "fits");
  assert.ok(cut.length >= 10, "keeps as much as fits");
  assert.equal(ellipsize("abcdefghij", 15, measure), "ab…");
  assert.equal(ellipsize("abc", 3, measure), "…", "even the ellipsis may be all that fits");
  assert.equal(ellipsize("", 50, measure), "");
});

test("the selected record's strip is brighter than the others", () => {
  assert.ok(stripOpacity(true) > stripOpacity(false));
  assert.equal(stripOpacity(true), 1);
});

test("the camera keeps the strips, those of the bottom row too, inside the stage", () => {
  const halfTan = Math.tan(((CAMERA_FOV / 2) * Math.PI) / 180);
  for (const [columns, aspect] of [[5, 760 / 400], [5, 1.2], [3, 343 / 300], [3, 0.8]]) {
    const distance = cameraDistance(columns, aspect);
    for (let index = 0; index < columns * SHELF_ROWS; index++) {
      const { x, y } = recordPosition(index, columns);
      for (const selected of [false, true]) {
        const pose = recordPose(index, { selected, columns, time: 0, reducedMotion: true });
        const bobbing = 0.05;
        const bottom = stripY(pose.y, pose.scale) - STRIP_HEIGHT / 2 - bobbing;
        assert.ok(Math.abs(bottom) <= halfTan * (distance - pose.z), `strip bottom of record ${index}, selected ${selected}`);
        assert.ok(Math.abs(x) + STRIP_WIDTH / 2 <= halfTan * aspect * (distance - pose.z), `strip side of record ${index}`);
      }
    }
  }
  const taller = cameraDistance(5, 2);
  assert.ok(taller > 0 && taller < 15);
});

// ---- Cost: frame rate, pixel ratio, when to draw ----------------------------------------------

test("a phone or a narrow stage draws 30 frames a second, a desktop 60", () => {
  assert.equal(isLowPower({ coarsePointer: true, width: 1200 }), true, "a touch screen");
  assert.equal(isLowPower({ coarsePointer: false, width: 375 }), true, "a narrow stage");
  assert.equal(isLowPower({ coarsePointer: false, width: 900 }), false);
  assert.equal(isLowPower({ coarsePointer: false, width: 0 }), false, "a hidden stage has no width to judge by");
  assert.equal(targetFps(true), 30);
  assert.equal(targetFps(false), 60);
});

test("phones render fewer pixels than desktops, and no device pays for more than 2× its CSS size", () => {
  assert.ok(pixelRatioFor(3, true) < pixelRatioFor(3, false), "lower on a phone");
  assert.equal(pixelRatioFor(1, false), 0.6);
  assert.equal(pixelRatioFor(3, false), 1.2, "capped at 2 before scaling");
  assert.equal(pixelRatioFor(0, false), 0.6, "an unknown ratio counts as 1");
  assert.ok(pixelRatioFor(2, true) >= 0.9, "still sharp enough to read a title");
});

test("a frame is drawn when it is due, not before; the frame cap tolerates a display's slightly early frames", () => {
  const base = { visible: true, animated: true, dirty: false, fps: 30, last: 1000 };
  assert.equal(shouldRenderFrame({ ...base, now: 1000 + 16.7 }), false, "a 60 Hz display's next frame is too soon for 30 fps");
  assert.equal(shouldRenderFrame({ ...base, now: 1000 + 33.3 }), true);
  assert.equal(shouldRenderFrame({ ...base, now: 1000 + 32 }), true, "a frame a little early still counts");
  assert.equal(shouldRenderFrame({ ...base, fps: 60, now: 1000 + 16.7 }), true);
  assert.equal(shouldRenderFrame({ ...base, now: 5000, last: Number.NEGATIVE_INFINITY }), true, "the first frame");
});

test("nothing is drawn while the stage is hidden or off screen, even when something changed", () => {
  const base = { animated: true, fps: 30, last: 0, now: 5000 };
  assert.equal(shouldRenderFrame({ ...base, visible: false, dirty: false }), false);
  assert.equal(shouldRenderFrame({ ...base, visible: false, dirty: true }), false);
});

test("under reduced motion a frame is drawn only after a change, whatever the time", () => {
  const base = { visible: true, animated: false, fps: 60, last: 0, now: 99999 };
  assert.equal(shouldRenderFrame({ ...base, dirty: false }), false);
  assert.equal(shouldRenderFrame({ ...base, dirty: true }), true);
  assert.equal(shouldRenderFrame({ ...base, dirty: true, fps: 30, now: 1 }), true, "a change ignores the frame cap");
});

test("a record grows toward its size at the same speed in time on a 30 or a 60 fps loop", () => {
  const per60 = scaleEasing(1000 / 60);
  assert.ok(Math.abs(per60 - 0.15) < 1e-9, "the old per-frame step at 60 fps");
  const twoSteps = 1 - (1 - per60) ** 2;
  assert.ok(Math.abs(scaleEasing(1000 / 30) - twoSteps) < 1e-9, "one 30 fps frame is two 60 fps frames");
  assert.equal(scaleEasing(0), 0);
  assert.ok(scaleEasing(5000) < 1 && scaleEasing(5000) === scaleEasing(100), "a long pause is capped, so the jump is not instant");
});
