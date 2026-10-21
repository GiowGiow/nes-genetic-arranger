// @ts-check
// Tests for ui/pacing.js: how often the page redraws while a run evolves or music plays.
//
// A phone has one slow main thread. Drawing the chart for every progress message, or the
// playhead for a moment that did not change, takes time the sound and the touches need. The
// pacer and the frame gate are the two rules that keep drawing rare: they are plain functions of
// a clock, so the tests drive them with a fake one.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createFrameGate, createPacer, drawingBudget } from "../src/ui/pacing.js";

/** A clock and a timer queue the test advances by hand. */
function fakeClock() {
  let time = 0;
  /** @type {Array<{at: number, run: () => void, id: number}>} */
  let timers = [];
  let nextId = 1;
  return {
    now: () => time,
    setTimer: (/** @type {() => void} */ run, /** @type {number} */ delay) => {
      const id = nextId++;
      timers.push({ at: time + delay, run, id });
      return id;
    },
    clearTimer: (/** @type {number} */ id) => {
      timers = timers.filter((timer) => timer.id !== id);
    },
    /** @param {number} milliseconds */
    advance(milliseconds) {
      const end = time + milliseconds;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((timer) => timer !== due);
        time = due.at;
        due.run();
      }
      time = end;
    },
    pending: () => timers.length,
  };
}

test("the first request draws at once, because nothing was drawn for a long time", () => {
  const clock = fakeClock();
  let draws = 0;
  const pacer = createPacer(() => draws++, { intervalMs: 250, ...clock });
  pacer.request();
  assert.equal(draws, 1);
});

test("requests that come faster than the interval are folded into one draw at the end of the interval", () => {
  const clock = fakeClock();
  let draws = 0;
  const pacer = createPacer(() => draws++, { intervalMs: 250, ...clock });
  pacer.request();
  for (let step = 0; step < 10; step += 1) {
    clock.advance(20); // a progress message every 20 ms, for 200 ms
    pacer.request();
  }
  assert.equal(draws, 1, "nothing more is drawn inside the interval");
  clock.advance(50);
  assert.equal(draws, 2, "the last request is drawn when the interval has passed");
  clock.advance(1000);
  assert.equal(draws, 2, "no request, no draw");
});

test("the last request is never lost: a single request inside the interval is drawn when it ends", () => {
  const clock = fakeClock();
  const drawnAt = /** @type {number[]} */ ([]);
  const pacer = createPacer(() => drawnAt.push(clock.now()), { intervalMs: 250, ...clock });
  pacer.request(); // drawn at 0
  clock.advance(100);
  pacer.request(); // too soon
  clock.advance(400);
  assert.deepEqual(drawnAt, [0, 250]);
});

test("a request after a quiet interval draws at once again", () => {
  const clock = fakeClock();
  let draws = 0;
  const pacer = createPacer(() => draws++, { intervalMs: 250, ...clock });
  pacer.request();
  clock.advance(1000);
  pacer.request();
  assert.equal(draws, 2);
});

test("cancel drops the draw that was waiting", () => {
  const clock = fakeClock();
  let draws = 0;
  const pacer = createPacer(() => draws++, { intervalMs: 250, ...clock });
  pacer.request();
  clock.advance(10);
  pacer.request();
  pacer.cancel();
  clock.advance(1000);
  assert.equal(draws, 1);
  assert.equal(clock.pending(), 0);
});

test("the frame gate lets a frame through when something changed and enough time passed", () => {
  const gate = createFrameGate(33);
  assert.equal(gate(0, "a"), true, "the first frame always draws");
  assert.equal(gate(10, "b"), false, "changed, but too soon after the last drawn frame");
  assert.equal(gate(40, "b"), true, "changed and 40 ms later");
});

test("the frame gate skips a frame that would look the same, however long it has been", () => {
  const gate = createFrameGate(33);
  assert.equal(gate(0, "paused at 12.5 s"), true);
  assert.equal(gate(1000, "paused at 12.5 s"), false, "a paused player is not redrawn");
  assert.equal(gate(2000, "paused at 13 s"), true, "a seek is");
});

test("a skipped frame does not use up the interval: the changed frame that follows draws", () => {
  const gate = createFrameGate(33);
  gate(0, "a");
  gate(10, "b"); // skipped, too soon
  assert.equal(gate(34, "b"), true, "the interval counts from the last drawn frame, not the last skipped one");
});

test("with no minimum interval the gate only compares what is drawn", () => {
  const gate = createFrameGate(0);
  assert.equal(gate(0, 1), true);
  assert.equal(gate(1, 1), false);
  assert.equal(gate(2, 2), true);
});

test("a forced frame draws whatever the key and the interval say, and counts as the last drawn frame", () => {
  const gate = createFrameGate(33);
  assert.equal(gate(0, "a"), true);
  assert.equal(gate(1, "a", true), true, "a resize or a new scene must be drawn");
  assert.equal(gate(2, "a"), false, "and the frame right after, unchanged, is not");
  assert.equal(gate(10, "b"), false, "the interval counts from the forced frame");
});

test("a phone (a coarse pointer) gets a smaller drawing budget: no glow, fewer pixels, at most 30 frames a second", () => {
  const phone = drawingBudget(true);
  const desktop = drawingBudget(false);
  assert.equal(phone.glow, false, "canvas shadows are slow in software canvases");
  assert.equal(desktop.glow, true, "the desktop keeps its look");
  assert.ok(phone.maxPixelRatio <= 1.5 && desktop.maxPixelRatio >= 2);
  assert.ok(phone.minFrameMs >= 33, "30 frames a second at most");
  assert.equal(desktop.minFrameMs, 0, "every frame on the desktop");
  assert.ok(phone.chartIntervalMs > desktop.chartIntervalMs, "the evolution chart redraws less often on a phone");
});

test("the budget has a sane evolution-chart rate on both: a few redraws a second, not one per message", () => {
  for (const coarse of [true, false]) {
    const { chartIntervalMs } = drawingBudget(coarse);
    assert.ok(chartIntervalMs >= 200 && chartIntervalMs <= 1000);
  }
});
