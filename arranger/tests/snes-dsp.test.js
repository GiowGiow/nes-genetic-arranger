// @ts-check
// Tests for audio/snes-dsp.js: the sample playback and echo of the Super Nintendo's DSP.
//
// The rules they state: a sample is pitched by stepping through it faster or slower (and the
// pitch has 14 bits, so it is a multiple of 1/4096); the 4-point Gaussian interpolation rounds
// every step into the next, which low-passes the sound; the envelope has the DSP's ADSR shape;
// and the echo returns the sound after a delay, again and again, each time quieter and darker.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DSP_RATE,
  MAX_PITCH_STEP,
  adsrLevel,
  echo,
  gaussianWeights,
  playSample,
  quantizePitch,
  resampleTo,
} from "../src/audio/snes-dsp.js";
import { peakFrequency } from "./spectrum.js";

/** One cycle of a sine in `length` samples. */
const sineCycle = (/** @type {number} */ length) => Float64Array.from({ length }, (_, i) => Math.sin((2 * Math.PI * i) / length));

test("the DSP runs at 32 kHz and plays a sample up to 4 times faster than it was recorded", () => {
  assert.equal(DSP_RATE, 32000);
  assert.ok(Math.abs(MAX_PITCH_STEP - 4) < 1e-3 && MAX_PITCH_STEP < 4);
});

test("the pitch has 14 bits: a multiple of 1/4096, no higher than 0x3FFF/4096", () => {
  assert.equal(quantizePitch(1), 1);
  assert.equal(quantizePitch(1.00001), 1);
  assert.equal(quantizePitch(1.5 + 0.4 / 4096), 1.5);
  assert.equal(quantizePitch(9), 0x3fff / 4096, "too high a pitch is held at the maximum");
  assert.equal(quantizePitch(0), 0);
});

test("the Gaussian weights are positive, sum to 1 and lean on the nearest samples", () => {
  for (let fraction = 0; fraction < 1; fraction += 1 / 16) {
    const weights = gaussianWeights(fraction);
    assert.equal(weights.length, 4);
    assert.ok(Math.abs(weights.reduce((sum, w) => sum + w, 0) - 1) < 1e-12);
    assert.ok(weights.every((w) => w >= 0));
  }
  // Even on a sample (fraction 0) the neighbours count: that is the softness of the SNES
  const [before, on, after, far] = gaussianWeights(0);
  assert.ok(on > 0.6 && on < 0.7, `the sample itself: ${on}`);
  assert.ok(Math.abs(before - after) < 1e-12 && before > 0.15 && before < 0.2);
  assert.ok(far < 0.01);
  // Halfway between two samples the two nearest share the weight
  const [a, b, c, d] = gaussianWeights(0.5);
  assert.ok(Math.abs(b - c) < 1e-12 && Math.abs(a - d) < 1e-12 && b > 0.4 && b > a);
});

test("a sample played at its own rate comes back, softened, and at half rate it is stretched to twice as long", () => {
  const ramp = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i / 10));
  const same = playSample({ data: ramp, loopStart: 0 }, 1, 40);
  const half = playSample({ data: ramp, loopStart: 0 }, 0.5, 80);
  // A smooth, slow signal is nearly unchanged by the interpolation
  for (let i = 5; i < 35; i++) assert.ok(Math.abs(same[i] - ramp[i]) < 0.05, `sample ${i}`);
  for (let i = 10; i < 70; i++) assert.ok(Math.abs(half[i] - Math.sin(i / 2 / 10)) < 0.05, `sample ${i}`);
});

test("the pitch of a resampled loop is exact: step × the loop's own frequency", () => {
  const loop = sineCycle(64); // 500 Hz at 32 kHz
  for (const step of [0.5, 1, 1.7, 2.5, 3.9]) {
    const wanted = quantizePitch(step) * (DSP_RATE / 64);
    const played = playSample({ data: loop, loopStart: 0 }, step, 32768);
    assert.ok(Math.abs(peakFrequency(played, DSP_RATE) - wanted) / wanted < 0.002, `step ${step}: ${peakFrequency(played, DSP_RATE)} Hz, wanted ${wanted}`);
  }
});

test("the Gaussian interpolation is a low-pass: a constant passes, the Nyquist tone is cut by more than 10 dB", () => {
  const constant = playSample({ data: new Float64Array(16).fill(1), loopStart: 0 }, 1, 100);
  assert.ok(constant.slice(4).every((value) => Math.abs(value - 1) < 1e-9), "DC gain 1");
  const nyquist = playSample({ data: Float64Array.from({ length: 16 }, (_, i) => (i % 2 ? -1 : 1)), loopStart: 0 }, 1, 100);
  const amplitude = Math.abs(nyquist[50]);
  assert.ok(amplitude < 0.35 && amplitude > 0.2, `${20 * Math.log10(amplitude)} dB at 16 kHz`);
  const quarter = playSample({ data: sineCycle(4), loopStart: 0 }, 1, 100); // 8 kHz
  const middle = Math.max(...quarter.slice(40).map(Math.abs));
  assert.ok(middle > 0.5 && middle < 0.8, `8 kHz at ${middle}`);
});

test("interpolation never overshoots the samples", () => {
  const data = Float64Array.from([0, 1, 1, 0, -1, -1, 0, 1, 0, 0, 0, 1, -1, 1, -1, 0]);
  const played = playSample({ data, loopStart: 0 }, 0.37, 400);
  assert.ok(Math.max(...played) <= 1 + 1e-12 && Math.min(...played) >= -1 - 1e-12);
});

test("a looped sample plays its intro once and then repeats from the loop point", () => {
  const data = Float64Array.from([5, 5, 5, 0, 1, 0, 1, 0]); // an intro of 3 samples, then the loop 0,1,0,1,0
  const played = playSample({ data, loopStart: 3 }, 1, 80);
  // With a loop the sound goes on, and never returns to the intro's level of 5
  assert.ok(played.slice(10).every((value) => Math.abs(value) < 1.2));
  assert.ok(played.slice(0, 3).some((value) => value > 3), "the intro is heard first");
});

test("a pitch that changes with time bends the note: it can be a function of seconds", () => {
  const loop = sineCycle(64);
  const flat = playSample({ data: loop, loopStart: 0 }, 1, 96000);
  const bent = playSample({ data: loop, loopStart: 0 }, (seconds) => (seconds < 1 ? 1 : 2), 96000);
  assert.deepEqual(bent.slice(0, 31000), flat.slice(0, 31000), "the first second is the same");
  const early = peakFrequency(bent.subarray(0, 31000), DSP_RATE);
  const late = peakFrequency(bent.subarray(33000, 96000), DSP_RATE);
  assert.ok(late / early > 1.95 && late / early < 2.05, `${early} Hz then ${late} Hz`);
});

test("the envelope rises linearly, falls exponentially to the sustain level and holds it", () => {
  const envelope = { attack: 0.1, decay: 0.2, sustain: 0.5, sustainFall: Infinity, release: 0.1 };
  assert.equal(adsrLevel(envelope, 0), 0);
  assert.ok(Math.abs(adsrLevel(envelope, 0.05) - 0.5) < 1e-12, "halfway up the attack");
  assert.ok(Math.abs(adsrLevel(envelope, 0.1) - 1) < 1e-12);
  assert.ok(Math.abs(adsrLevel(envelope, 0.2) - Math.sqrt(0.5)) < 1e-9, "half-way in time to the sustain level, half-way in dB");
  assert.ok(Math.abs(adsrLevel(envelope, 0.3) - 0.5) < 1e-12);
  assert.equal(adsrLevel(envelope, 10), 0.5, "held for ever");
});

test("the sustain can keep falling, 40 dB per `sustainFall` seconds", () => {
  const envelope = { attack: 0, decay: 0.1, sustain: 0.8, sustainFall: 2, release: 0.1 };
  assert.ok(Math.abs(adsrLevel(envelope, 0.1) - 0.8) < 1e-12);
  assert.ok(Math.abs(adsrLevel(envelope, 2.1) - 0.8 * 0.01) < 1e-9);
});

test("the release falls linearly to silence from wherever the note was", () => {
  const envelope = { attack: 0.1, decay: 0.2, sustain: 0.5, sustainFall: Infinity, release: 0.1 };
  assert.ok(Math.abs(adsrLevel(envelope, 1.05, 1) - 0.25) < 1e-12);
  assert.equal(adsrLevel(envelope, 1.1, 1), 0);
  assert.equal(adsrLevel(envelope, 5, 1), 0);
  // Released during the attack, it falls from the level reached
  assert.ok(Math.abs(adsrLevel(envelope, 0.075, 0.05) - 0.375) < 1e-12, "0.5 reached, 25% of the release gone");
});

test("the echo returns the sound after its delay, again and again, each time feedback times quieter", () => {
  const delay = 1000;
  const input = new Float64Array(6000);
  input[10] = 1;
  const passThrough = [1, 0, 0, 0, 0, 0, 0, 0];
  const wet = echo(input, { delay, feedback: 0.5, fir: passThrough });
  assert.equal(wet.length, input.length);
  for (let i = 0; i < 10 + delay; i++) assert.equal(wet[i], 0, `nothing before the delay (${i})`);
  assert.equal(wet[10 + delay], 1);
  assert.equal(wet[10 + 2 * delay], 0.5);
  assert.equal(wet[10 + 3 * delay], 0.25);
  assert.equal(wet[10 + 4 * delay], 0.125);
  assert.equal(wet[10 + 4 * delay + 1], 0);
});

test("the echo's filter makes each repeat darker as well as quieter", () => {
  const delay = 500;
  const input = new Float64Array(5000);
  for (let i = 0; i < 40; i++) input[i] = i % 2 ? -1 : 1; // a burst at the Nyquist frequency
  const lowpass = [0.25, 0.25, 0.25, 0.25, 0, 0, 0, 0]; // a moving average of 4: kills the Nyquist tone
  const wet = echo(input, { delay, feedback: 0.5, fir: lowpass });
  const level = (/** @type {number} */ from) => Math.max(...wet.slice(from, from + 100).map(Math.abs));
  assert.ok(level(delay) < 0.3, "the first repeat has already lost most of its highs");
  assert.ok(level(2 * delay) < level(delay) * 0.5 + 1e-9);
});

test("resampling to another rate keeps a tone's pitch, level and length in seconds", () => {
  const tone = Float64Array.from({ length: 32000 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / DSP_RATE));
  const resampled = resampleTo(tone, 44100, 44100);
  assert.equal(resampled.length, 44100);
  assert.ok(Math.abs(peakFrequency(resampled, 44100) - 1000) < 2);
  for (let i = 100; i < 1000; i += 13) {
    assert.ok(Math.abs(resampled[i] - Math.sin((2 * Math.PI * 1000 * i) / 44100)) < 5e-3, `sample ${i}`);
  }
  assert.deepEqual(resampleTo(tone, 32000, 32000), tone, "at the same rate nothing changes");
});
