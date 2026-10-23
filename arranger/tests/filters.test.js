// @ts-check
// Tests for audio/filters.js: the small filters that shape the sound packs.
//
// A filter is checked by its frequency response: a sine of a given frequency goes in, and the
// level of the sine that comes out (after the filter has settled) is compared with the level
// that went in. The rules below are the textbook ones: a first-order filter is 3 dB down at its
// cutoff and falls 6 dB per octave beyond it; the second-order low-pass is 3 dB down at its cutoff
// and 12 dB per octave beyond it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { biquadLowpass, highpass, lowpass } from "../src/audio/filters.js";

const RATE = 44100;

/**
 * The gain of a filter at one frequency, in dB: the RMS of a sine after the filter (the first
 * half second, where the filter is still settling, is ignored) against the sine's own RMS.
 * @param {(samples: Float64Array) => void} filter
 * @param {number} hz
 */
function gainDb(filter, hz) {
  const samples = new Float64Array(RATE);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * hz * i) / RATE);
  filter(samples);
  let sum = 0;
  for (let i = RATE / 2; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / (RATE / 2));
  return 20 * Math.log10(rms / Math.SQRT1_2);
}

test("a one-pole low-pass is 3 dB down at its cutoff, passes the low and falls about 6 dB per octave above", () => {
  const filter = (/** @type {Float64Array} */ samples) => lowpass(samples, 1000, RATE);
  assert.ok(Math.abs(gainDb(filter, 50)) < 0.1, "a low tone passes");
  assert.ok(Math.abs(gainDb(filter, 1000) + 3) < 0.6, `cutoff: ${gainDb(filter, 1000)}`);
  // Measured well below half the sample rate, where the digital filter still follows the analog one
  const octave = gainDb(filter, 4000) - gainDb(filter, 8000);
  assert.ok(octave > 5 && octave < 6.5, `${octave} dB per octave`);
});

test("a one-pole high-pass is 3 dB down at its cutoff, blocks the low and passes the high", () => {
  const filter = (/** @type {Float64Array} */ samples) => highpass(samples, 90, RATE);
  assert.ok(gainDb(filter, 20) < -12, "a very low tone is blocked");
  assert.ok(Math.abs(gainDb(filter, 90) + 3) < 0.6, `cutoff: ${gainDb(filter, 90)}`);
  assert.ok(Math.abs(gainDb(filter, 2000)) < 0.1, "a high tone passes");
});

test("a high-pass removes a constant offset", () => {
  const samples = new Float64Array(RATE).fill(0.5);
  highpass(samples, 90, RATE);
  assert.ok(Math.abs(samples[samples.length - 1]) < 1e-3);
});

test("the second-order low-pass is 3 dB down at its cutoff and falls 12 dB per octave above", () => {
  const filter = (/** @type {Float64Array} */ samples) => biquadLowpass(samples, 1000, RATE);
  assert.ok(Math.abs(gainDb(filter, 50)) < 0.1, "a low tone passes");
  assert.ok(Math.abs(gainDb(filter, 1000) + 3) < 0.7, `cutoff: ${gainDb(filter, 1000)}`);
  const octave = gainDb(filter, 4000) - gainDb(filter, 8000);
  assert.ok(octave > 11 && octave < 14.5, `${octave} dB per octave`);
});

test("a filter works in place on Float32 arrays too and leaves silence silent", () => {
  const quiet = new Float32Array(100);
  lowpass(quiet, 1000, RATE);
  highpass(quiet, 90, RATE);
  biquadLowpass(quiet, 6000, RATE);
  assert.ok(quiet.every((value) => value === 0));
});
