// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  drumTicks,
  headNote,
  pitchSpan,
  pitchToY,
  roundedPath,
  stepPolylines,
  timeToX,
  timeWindow,
  visibleSegments,
} from "../src/ui/channel-paths.js";

const note = (/** @type {number} */ pitch, /** @type {number} */ onset, /** @type {number} */ duration) =>
  ({ pitch, onset, duration });

/** One second is 100 px and the window starts at second 0, so x is easy to read in the tests. */
const scale = { xOf: (/** @type {number} */ time) => time * 100, yOf: (/** @type {number} */ pitch) => 200 - pitch };
const everything = { ...scale, t: 100, minX: -1000, gap: 0 };

// --- Time window ---------------------------------------------------------------------------

test("the time window puts the playhead near the right edge and shows the recent past", () => {
  const window = timeWindow(10, 8, 0.8);
  assert.equal(window.end - window.start, 8);
  assert.ok(Math.abs(window.start - (10 - 6.4)) < 1e-9, "the head sits at 80% of the window");
  assert.ok(Math.abs(timeToX(10, window, 1000) - 800) < 1e-9);
  assert.equal(timeToX(window.start, window, 1000), 0);
  assert.equal(timeToX(window.end, window, 1000), 1000);
});

// --- Pitch to height -----------------------------------------------------------------------

test("the pitch span covers every note of every voice with a margin", () => {
  const span = pitchSpan([[note(40, 0, 1)], [note(72, 0, 1), note(60, 1, 1)]], 2);
  assert.deepEqual(span, { low: 38, high: 74 });
});

test("a narrow or empty pitch span is widened so a flat tune does not fill the whole height", () => {
  const flat = pitchSpan([[note(60, 0, 1)]], 1, 12);
  assert.equal(flat.high - flat.low, 12);
  assert.equal((flat.high + flat.low) / 2, 60, "the single pitch stays in the middle");
  const empty = pitchSpan([[]], 1, 12);
  assert.ok(empty.high - empty.low >= 12);
});

test("a high pitch is drawn near the top and a low pitch near the bottom of the pitch lane", () => {
  const span = { low: 40, high: 80 };
  const lane = { top: 10, bottom: 110 };
  assert.equal(pitchToY(80, span, lane), 10);
  assert.equal(pitchToY(40, span, lane), 110);
  assert.equal(pitchToY(60, span, lane), 60);
});

// --- Step polylines ------------------------------------------------------------------------

test("a note is a flat segment, and the next pitch is a vertical jump where it starts", () => {
  const runs = stepPolylines([note(60, 0, 1), note(64, 1, 1)], everything);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0], [
    { x: 0, y: 140 },
    { x: 100, y: 140 },
    { x: 100, y: 136 },
    { x: 200, y: 136 },
  ]);
});

test("a rest ends the run, and the next note starts a new one", () => {
  const runs = stepPolylines([note(60, 0, 1), note(62, 2, 1)], everything);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0], [{ x: 0, y: 140 }, { x: 100, y: 140 }]);
  assert.deepEqual(runs[1], [{ x: 200, y: 138 }, { x: 300, y: 138 }]);
});

test("a repeated note leaves a small gap in the line and no jump", () => {
  const runs = stepPolylines([note(60, 0, 1), note(60, 1, 1), note(60, 2, 1)], { ...everything, gap: 6 });
  assert.equal(runs.length, 3);
  assert.deepEqual(runs[0], [{ x: 0, y: 140 }, { x: 94, y: 140 }], "the first note stops 6 px early");
  assert.deepEqual(runs[1], [{ x: 100, y: 140 }, { x: 194, y: 140 }]);
  assert.deepEqual(runs[2], [{ x: 200, y: 140 }, { x: 300, y: 140 }], "the last note keeps its end");
});

test("a very short repeated note keeps most of its length when the gap is wider than it", () => {
  const runs = stepPolylines([note(60, 0, 0.05), note(60, 0.05, 1)], { ...everything, gap: 30 });
  const first = runs[0];
  assert.ok(first[1].x - first[0].x >= 3, "5 px long, at least 3 px stay");
});

test("a changed pitch with no rest is joined even when the notes are short", () => {
  const runs = stepPolylines([note(60, 0, 0.5), note(61, 0.5, 0.5)], { ...everything, gap: 6 });
  assert.equal(runs.length, 1);
});

test("the playhead cuts the line: notes that have not started are left out, the sounding one stops at now", () => {
  const runs = stepPolylines([note(60, 0, 1), note(62, 1, 2), note(64, 3, 1)], { ...everything, t: 1.5 });
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].at(-1), { x: 150, y: 138 });
  assert.ok(runs[0].every((point) => point.x <= 150));
});

test("the left edge cuts the line: a note that enters from the left starts at the edge", () => {
  const runs = stepPolylines([note(60, 0, 3), note(62, 3, 1)], { ...everything, minX: 100 });
  assert.deepEqual(runs[0][0], { x: 100, y: 140 });
  const gone = stepPolylines([note(60, 0, 1), note(62, 5, 1)], { ...everything, minX: 300 });
  assert.equal(gone.length, 1, "the note that ended left of the edge is not drawn");
  assert.deepEqual(gone[0][0], { x: 500, y: 138 });
});

test("a note that starts before the previous one ends cuts it short, as the later note wins", () => {
  const runs = stepPolylines([note(60, 0, 4), note(64, 1, 1)], everything);
  assert.deepEqual(runs[0], [
    { x: 0, y: 140 },
    { x: 100, y: 140 },
    { x: 100, y: 136 },
    { x: 200, y: 136 },
  ]);
});

test("there is no line without notes, and no line before the first note", () => {
  assert.deepEqual(stepPolylines([], everything), []);
  assert.deepEqual(stepPolylines([note(60, 2, 1)], { ...everything, t: 1 }), []);
});

// --- Rounded corners -----------------------------------------------------------------------

test("a step path rounds each corner with an arc that ends on the next segment", () => {
  const points = [{ x: 0, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 30 }, { x: 100, y: 30 }];
  const path = roundedPath(points, 4);
  assert.deepEqual(path[0], { op: "moveTo", args: [0, 10] });
  assert.deepEqual(path[1], { op: "arcTo", args: [50, 10, 50, 30, 4] });
  assert.deepEqual(path[2], { op: "arcTo", args: [50, 30, 100, 30, 4] });
  assert.deepEqual(path[3], { op: "lineTo", args: [100, 30] });
  assert.equal(path.length, 4);
});

test("the corner radius shrinks to half of a short segment so neighbouring corners do not overlap", () => {
  const points = [{ x: 0, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 14 }, { x: 100, y: 14 }];
  const path = roundedPath(points, 6);
  assert.equal(path[1].args[4], 2, "the 4 px jump leaves 2 px for each corner");
  assert.equal(path[2].args[4], 2);
});

test("a single flat segment is a plain line, and an empty path is empty", () => {
  assert.deepEqual(roundedPath([{ x: 0, y: 5 }, { x: 9, y: 5 }], 4), [
    { op: "moveTo", args: [0, 5] },
    { op: "lineTo", args: [9, 5] },
  ]);
  assert.deepEqual(roundedPath([], 4), []);
});

// --- Head, dashes and drums ----------------------------------------------------------------

test("the head note is the note sounding now, and there is none in a rest or before and after the line", () => {
  const notes = [note(60, 0, 1), note(62, 2, 1)];
  assert.equal(headNote(notes, 0.5)?.pitch, 60);
  assert.equal(headNote(notes, 1.5), null);
  assert.equal(headNote(notes, 2.99)?.pitch, 62);
  assert.equal(headNote(notes, 3), null);
  assert.equal(headNote(notes, -1), null);
  assert.equal(headNote([], 1), null);
});

test("when notes overlap, the head is the one that started last", () => {
  assert.equal(headNote([note(60, 0, 4), note(64, 1, 1)], 1.5)?.pitch, 64);
  assert.equal(headNote([note(60, 0, 4), note(64, 1, 1)], 2.5), null, "the cut-short first note is silent");
});

test("visible segments are the notes inside the window, cut at its edges and at now", () => {
  const notes = [note(60, 0, 2), note(62, 3, 2), note(64, 9, 1)];
  assert.deepEqual(visibleSegments(notes, 1, 4), [
    { pitch: 60, from: 1, to: 2 },
    { pitch: 62, from: 3, to: 4 },
  ]);
  assert.deepEqual(visibleSegments(notes, 6, 8), []);
});

test("drum ticks within the window fade with age down to a floor", () => {
  const ticks = drumTicks([0.5, 5, 9.5, 12], 4, 10, 2);
  assert.deepEqual(ticks.map((tick) => tick.onset), [5, 9.5], "0.5 is left of the window, 12 has not played");
  assert.ok(ticks[1].alpha > ticks[0].alpha, "the newer hit is brighter");
  assert.equal(ticks[0].alpha, 0.2, "an old hit stays faintly visible until it leaves");
  assert.ok(Math.abs(ticks[1].alpha - 0.75) < 1e-9);
});
