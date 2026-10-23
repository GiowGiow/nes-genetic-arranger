// @ts-check
// Tests for the pure parts of the evolution "lab" look: the mechanical counter's digits, the
// oscilloscope's graticule and axis, and the state of the screen before and while a run starts.
// The drawing and the CSS are checked in the browser.

import assert from "node:assert/strict";
import { test } from "node:test";

import { counterDigits, counterMarkup, scopeAxis, screenState } from "../src/ui/evolution-view.js";

test("a counter shows a fixed number of digit wheels, with the leading zeros dimmed", () => {
  assert.deepEqual(counterDigits(7, 4), [
    { char: "0", dim: true },
    { char: "0", dim: true },
    { char: "0", dim: true },
    { char: "7", dim: false },
  ]);
  assert.deepEqual(counterDigits(1203, 4).map((digit) => digit.char).join(""), "1203");
  assert.equal(counterDigits(1203, 4).some((digit) => digit.dim), false);
});

test("zero shows one live digit, not a row of dim ones", () => {
  const digits = counterDigits(0, 3);
  assert.deepEqual(digits.map((digit) => digit.dim), [true, true, false]);
});

test("a number wider than the counter shows its last digits, as a real counter rolls over", () => {
  assert.equal(counterDigits(12345, 4).map((digit) => digit.char).join(""), "2345");
});

test("the counter's markup names its value for a screen reader and hides the wheels from it", () => {
  const markup = counterMarkup(counterDigits(42, 3), "Generation 42");

  assert.match(markup, /role="img"/);
  assert.match(markup, /aria-label="Generation 42"/);
  assert.equal(markup.match(/class="wheel/g)?.length, 3);
  assert.match(markup, /is-dim/);
});

test("the scope's axis starts below the lowest mean, in tenths, and ends at 1", () => {
  assert.deepEqual(scopeAxis([]), { yMin: 0, yMax: 1 });
  assert.deepEqual(scopeAxis([0.52, 0.8]), { yMin: 0.45, yMax: 1 });
  assert.deepEqual(scopeAxis([0.05]), { yMin: 0, yMax: 1 });
});

test("the screen says INSERT COIN while it waits for a run, and again while the run starts", () => {
  assert.deepEqual(screenState({ hasSong: true, running: false, generations: 0, hasRun: false }), {
    coin: true, blink: "slow", message: "Press Arrange to start",
  });
  assert.deepEqual(screenState({ hasSong: true, running: true, generations: 0, hasRun: false }), {
    coin: true, blink: "fast", message: "Starting the evolution…",
  });
});

test("once the first generation arrives the coin goes and the trace shows", () => {
  assert.equal(screenState({ hasSong: true, running: true, generations: 1, hasRun: true }).coin, false);
  assert.equal(screenState({ hasSong: true, running: false, generations: 200, hasRun: true }).coin, false);
});

test("with no song the screen asks for one instead of offering a coin", () => {
  assert.deepEqual(screenState({ hasSong: false, running: false, generations: 0, hasRun: false }), {
    coin: false, blink: "none", message: "Pick a song to see the evolution",
  });
});
