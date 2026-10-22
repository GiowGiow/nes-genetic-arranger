// @ts-check
// Tests for ui/shelf-layout.js: where each vinyl record of a page sits and moves, and how far
// the camera stands (spec 005, story 3, research R6). The three.js scene only applies these
// numbers, so they are tested here without WebGL.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CAMERA_FOV,
  HALO_SCALE,
  LABEL_HEIGHT_PX,
  MARQUEE_SPEED,
  NARROW_WIDTH,
  RECORD_SPACING,
  SHELF_ROWS,
  cameraDistance,
  haloOpacity,
  isLowPower,
  labelAnchorY,
  labelWidth,
  marqueeDelay,
  marqueeTiming,
  ndcToPixels,
  perPageFor,
  pixelRatioFor,
  pixelsPerUnit,
  recordPose,
  recordPosition,
  scaleEasing,
  shelfColumns,
  shouldRenderFrame,
  targetFps,
} from "../src/ui/shelf-layout.js";

test("columns follow the stage width: 3 on a phone, 5 at medium, 7 at wide, 9 at very wide; always 3 rows", () => {
  assert.equal(NARROW_WIDTH, 560);
  assert.equal(SHELF_ROWS, 3);
  const expected = [[320, 3], [375, 3], [559, 3], [560, 5], [759, 5], [760, 7], [959, 7], [960, 9], [1400, 9]];
  for (const [width, columns] of expected) assert.equal(shelfColumns(width), columns, `${width} px`);
  assert.equal(shelfColumns(0), 5, "a hidden shelf (width 0) keeps a medium layout");
  assert.equal(perPageFor(375), 9);
  assert.equal(perPageFor(700), 15);
  assert.equal(perPageFor(824), 21);
  assert.equal(perPageFor(1000), 27);
});

test("every column count keeps the records a sensible size where it starts", () => {
  // A scene unit is the radius of a full-size record; this is how many pixels it gets on a stage
  // as wide as the narrowest one that shows that many columns (338 × 344 px on a phone, else 400 high).
  for (const [width, height] of [[338, 344], [560, 400], [760, 400], [960, 400]]) {
    const columns = shelfColumns(width);
    const units = pixelsPerUnit(height, cameraDistance(columns, width / height));
    assert.ok(units >= 46, `${columns} columns on ${width} px: a unit is ${units.toFixed(1)} px, a resting record ${(1.16 * units).toFixed(0)} px wide`);
  }
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
  for (const [columns, aspect] of [[5, 760 / 400], [5, 1.2], [3, 343 / 300], [3, 0.8], [7, 824 / 400], [9, 1000 / 400]]) {
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
  for (const [columns, aspect] of [[5, 760 / 400], [5, 1.2], [3, 343 / 300], [3, 0.8], [7, 824 / 400], [9, 1000 / 400]]) {
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

// ---- Title labels under the records (DOM elements placed from the projected position) ---------

test("a point on the stage's centre line projects to the middle, the top edge to y 0 and the left edge to x 0", () => {
  assert.deepEqual(ndcToPixels({ x: 0, y: 0 }, 400, 300), { x: 200, y: 150 });
  assert.deepEqual(ndcToPixels({ x: -1, y: 1 }, 400, 300), { x: 0, y: 0 }, "top left");
  assert.deepEqual(ndcToPixels({ x: 1, y: -1 }, 400, 300), { x: 400, y: 300 }, "bottom right");
  assert.deepEqual(ndcToPixels({ x: 0.5, y: 0.5 }, 400, 300), { x: 300, y: 75 });
});

test("pixels per scene unit grow with the stage's height and shrink as the camera backs away", () => {
  const halfTan = Math.tan(((CAMERA_FOV / 2) * Math.PI) / 180);
  assert.ok(Math.abs(pixelsPerUnit(400, 10) - 400 / (2 * halfTan * 10)) < 1e-9);
  assert.ok(pixelsPerUnit(400, 10) > pixelsPerUnit(300, 10));
  assert.ok(pixelsPerUnit(400, 10) > pixelsPerUnit(400, 12));
});

test("a label is a little narrower than the gap between record centres, so neighbours never touch", () => {
  const unit = 60;
  const width = labelWidth(unit);
  assert.ok(width < RECORD_SPACING * unit, "narrower than the pitch");
  assert.ok(width > RECORD_SPACING * unit - 12, "but not by much: the title needs the room");
  assert.equal(labelWidth(1), 40, "never narrower than a few letters");
});

test("the label hangs from the record's lower rim, wherever the record is and however big", () => {
  assert.equal(labelAnchorY(0, 0.58), -0.58);
  assert.equal(labelAnchorY(0.12, 0.92), 0.12 - 0.92);
  assert.ok(labelAnchorY(0.12, 0.92) < labelAnchorY(0, 0.58), "the larger, raised record has a lower rim");
});

test("a title that fits stays still; a longer one slides by exactly what overflows, slowly, and rests at each end", () => {
  assert.equal(marqueeTiming(0), null);
  assert.equal(marqueeTiming(0.5), null, "a sub-pixel overflow is not worth moving for");
  const timing = marqueeTiming(90);
  assert.ok(timing);
  assert.equal(timing.shift, -90, "to the left, by the hidden width");
  assert.ok(MARQUEE_SPEED > 10 && MARQUEE_SPEED < 40, "slow enough to read");
  // The movement takes 64% of a pass (the rest is rest at the ends), at MARQUEE_SPEED
  assert.ok(Math.abs(timing.duration * 0.64 - 90 / MARQUEE_SPEED) < 1e-9);
  assert.ok(marqueeTiming(400).duration > timing.duration, "a longer title takes longer");
  assert.ok(Number(marqueeTiming(2)?.duration) >= 2.5, "never a frantic shake");
});

test("neighbouring labels start their slide at different moments, so the titles do not move in step", () => {
  const delays = [0, 1, 2, 3, 4, 5, 6, 7].map(marqueeDelay);
  assert.equal(delays[0], 0);
  assert.ok(delays[1] > delays[0]);
  assert.ok(Math.max(...delays) <= 3, "nobody waits long to start");
  assert.equal(marqueeDelay(6), marqueeDelay(0), "the pattern repeats across a page");
});

test("the camera keeps the labels, those of the bottom row too, inside the stage", () => {
  const halfTan = Math.tan(((CAMERA_FOV / 2) * Math.PI) / 180);
  for (const [columns, aspect] of [[3, 343 / 340], [5, 600 / 400], [7, 824 / 400], [9, 1000 / 400], [5, 0.9]]) {
    const distance = cameraDistance(columns, aspect);
    const unit = pixelsPerUnit(400, distance);
    for (let index = 0; index < columns * SHELF_ROWS; index++) {
      for (const selected of [false, true]) {
        const pose = recordPose(index, { selected, columns, time: 0, reducedMotion: true });
        const bobbing = 0.05;
        const labelBottom = labelAnchorY(pose.y, pose.scale) - bobbing - LABEL_HEIGHT_PX / unit;
        assert.ok(Math.abs(labelBottom) <= halfTan * (distance - pose.z), `label bottom of record ${index}, selected ${selected}, ${columns} columns`);
        assert.ok(Math.abs(pose.x) + labelWidth(unit) / unit / 2 <= halfTan * aspect * (distance - pose.z), `label side of record ${index}, ${columns} columns`);
      }
    }
  }
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
