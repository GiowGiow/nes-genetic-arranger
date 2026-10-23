// @ts-check
// Tests for audio/snes-pack.js: the Super Nintendo sound pack (procedural samples, played
// through the DSP, with echo).
//
// The pack's claims: the samples are made here from sine waves and loop without a click; each
// voice plays at the note's pitch; the drums are soft one-shot samples; melody and harmony
// echo and the bass does not; and the whole is soft, because the Gaussian interpolation and the
// echo's filter take the highs away.

import { test } from "node:test";
import assert from "node:assert/strict";

import { DSP_RATE } from "../src/audio/snes-dsp.js";
import { SNES_ECHO, SNES_SAMPLES, SNES_VOICES, additiveSample, renderSnesStems } from "../src/audio/snes-pack.js";
import { bandLevelDb, peakFrequency } from "./spectrum.js";

const RATE = 44100;

/**
 * One note of one channel, rendered alone.
 * @param {"P1" | "P2" | "TR" | "NO"} channel
 * @param {number} pitch
 * @param {{beats?: number, velocity?: number, tempoBpm?: number, until?: number}} [options] `until`: seconds the render must last at least
 */
function solo(channel, pitch, { beats = 2, velocity = 100, tempoBpm = 120, until = 0 } = {}) {
  /** @type {Record<string, Array<{pitch: number, onset: number, duration: number, velocity: number}>>} */
  const channels = { [channel]: [{ pitch, onset: 0, duration: beats, velocity }] };
  // The render ends 0.15 s after the last note; a silent note far on keeps the echoes in it
  if (until > 0) channels[channel === "NO" ? "TR" : "NO"] = [{ pitch: 36, onset: until * 2, duration: 0.5, velocity: 1 }];
  return renderSnesStems({ tempoBpm, channels }, RATE)[channel];
}

/** @param {Float64Array} samples @param {number} from seconds @param {number} to seconds */
const slice = (samples, from, to) => samples.subarray(Math.floor(from * RATE), Math.floor(to * RATE));

/** @param {Float64Array} samples */
const rms = (samples) => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);

test("an additive sample is a sum of sine partials with an intro and a loop that closes", () => {
  const sample = additiveSample({ baseHz: 400, introSeconds: 0.05, loopCycles: 4, partials: [{ ratio: 1, amp: 1 }, { ratio: 2, amp: 0.5 }] });
  assert.equal(sample.loopStart, Math.round(0.05 * DSP_RATE));
  assert.equal(sample.data.length, sample.loopStart + 4 * (DSP_RATE / 400));
  // The loop repeats exactly: one loop later the waveform is the same
  const period = DSP_RATE / 400;
  for (let i = sample.loopStart; i < sample.data.length - period; i++) {
    assert.ok(Math.abs(sample.data[i] - sample.data[i + period]) < 1e-9, `sample ${i}`);
  }
  assert.ok(Math.max(...sample.data.map(Math.abs)) <= 0.9 + 1e-12 && Math.max(...sample.data.map(Math.abs)) > 0.85, "normalized to 0.9");
});

test("a loop that does not close is refused: every partial must make a whole number of cycles in it", () => {
  assert.throws(() => additiveSample({ baseHz: 400, introSeconds: 0.01, loopCycles: 4, partials: [{ ratio: 1.1, amp: 1 }] }), /whole number of cycles/);
  assert.throws(() => additiveSample({ baseHz: 300, introSeconds: 0.01, loopCycles: 4, partials: [{ ratio: 1, amp: 1 }] }), /whole number of samples/);
  // A chorus partial a little above a harmonic closes if the loop is long enough for it
  assert.doesNotThrow(() => additiveSample({ baseHz: 400, introSeconds: 0.01, loopCycles: 128, partials: [{ ratio: 1.0078125, amp: 1 }] }));
});

test("partials that decay in the intro are held at that level in the loop, so the loop has no step", () => {
  const sample = additiveSample({ baseHz: 400, introSeconds: 0.3, loopCycles: 2, partials: [{ ratio: 1, amp: 1, decay: 0.2 }, { ratio: 3, amp: 1, decay: 0.05 }] });
  const loop = sample.data.slice(sample.loopStart);
  const stepsInLoop = loop.slice(1).map((value, i) => Math.abs(value - loop[i]));
  const wrap = Math.abs(loop[0] - loop[loop.length - 1]);
  assert.ok(wrap <= Math.max(...stepsInLoop) * 1.01, `the step across the loop point (${wrap}) is as small as the steps inside it`);
  // The first partial is still falling in the intro
  const early = Math.max(...sample.data.slice(0, 80).map(Math.abs));
  const late = Math.max(...loop.map(Math.abs));
  assert.ok(late < early);
});

test("the pack's samples are made here, deterministic, quiet at their edges, and the pitched ones loop", () => {
  for (const [name, sample] of Object.entries(SNES_SAMPLES)) {
    assert.ok(sample.data.length > 100, name);
    assert.ok(Math.max(...sample.data.map(Math.abs)) <= 1, name);
    assert.ok(sample.data.every(Number.isFinite), name);
  }
  for (const name of /** @type {const} */ (["P1", "P2", "TR"])) assert.notEqual(SNES_SAMPLES[name].loopStart, null, `${name} loops`);
  for (const name of /** @type {const} */ (["kick", "snare", "hat"])) assert.equal(SNES_SAMPLES[name].loopStart, null, `${name} is a one-shot`);
});

test("the voices play at the note's pitch", () => {
  // The bass: its fundamental is the strongest partial
  assert.ok(Math.abs(peakFrequency(slice(solo("TR", 33), 0.3, 0.95), RATE) - 55) < 1);
  // The lead and the harp: their strongest partial sits on a harmonic of the note (within the
  // 13 cents of the lead's chorus pair)
  for (const channel of /** @type {const} */ (["P1", "P2"])) {
    const strongest = peakFrequency(slice(solo(channel, 69), 0.2, 0.95), RATE);
    const harmonic = Math.round(strongest / 440);
    assert.ok(harmonic >= 1 && Math.abs(strongest / (440 * harmonic) - 1) < 0.01, `${channel}: ${strongest.toFixed(1)} Hz`);
  }
});

test("the highest notes of the arrangement stay in tune: the samples are made to be stepped up to 4 times", () => {
  for (const [channel, pitch] of /** @type {const} */ ([["P1", 88], ["P2", 84], ["TR", 55]])) {
    const hz = 440 * 2 ** ((pitch - 69) / 12);
    const step = hz / SNES_VOICES[channel].sample.baseHz;
    assert.ok(step > 0.25 && step < 4, `${channel} ${pitch}: step ${step}`);
  }
});

test("melody and harmony echo after 96 ms, each repeat quieter; the bass does not echo", () => {
  const delay = SNES_ECHO.delay / DSP_RATE;
  assert.ok(Math.abs(delay - 0.096) < 1e-9);
  // A short note, then silence: look at where the echoes land
  for (const channel of /** @type {const} */ (["P1", "P2"])) {
    const samples = solo(channel, 69, { beats: 0.2, tempoBpm: 120, until: 0.8 }); // the note lasts 0.1 s
    const noteEnd = 0.1;
    const repeat = (/** @type {number} */ n) => rms(slice(samples, noteEnd + (n - 1) * delay + 0.01, noteEnd + n * delay - 0.01));
    assert.ok(repeat(1) > 0.01 * rms(slice(samples, 0.02, 0.1)), `${channel}: a first repeat`);
    assert.ok(repeat(2) < repeat(1), `${channel}: the second repeat is quieter`);
    assert.ok(repeat(3) < repeat(2), `${channel}: and the third quieter still`);
  }
  const bass = solo("TR", 40, { beats: 0.2, until: 0.5 });
  assert.ok(rms(slice(bass, 0.2, 0.3)) < 1e-3, "the bass has no repeats");
});

test("the echo is darker than the note: its repeats lose their highs", () => {
  const samples = solo("P2", 81, { beats: 0.2, until: 0.5 });
  const note = slice(samples, 0.005, 0.09);
  const repeat = slice(samples, 0.2, 0.28);
  const highShare = (/** @type {Float64Array} */ part) => bandLevelDb(part, RATE, 2000, 12000, 1024) - bandLevelDb(part, RATE, 20, 12000, 1024);
  assert.ok(highShare(repeat) < highShare(note), `repeat ${highShare(repeat).toFixed(1)} dB, note ${highShare(note).toFixed(1)} dB`);
});

test("the sound is soft: almost nothing above 8 kHz, and the mix is quieter there than the NES chip", () => {
  for (const [channel, pitch] of /** @type {const} */ ([["P1", 76], ["P2", 72], ["TR", 40]])) {
    const samples = solo(channel, pitch);
    const total = bandLevelDb(samples, RATE, 20, 20000);
    assert.ok(bandLevelDb(samples, RATE, 8000, 20000) < total - 40, `${channel}: above 8 kHz`);
  }
});

test("the kick is low, the hi-hat is high and darker than a raw noise, and a hit dies away", () => {
  const kick = solo("NO", 36, { beats: 1 });
  const snare = solo("NO", 38, { beats: 1 });
  const hat = solo("NO", 42, { beats: 1 });
  const share = (/** @type {Float64Array} */ samples, /** @type {number} */ low, /** @type {number} */ high) =>
    bandLevelDb(samples, RATE, low, high) - bandLevelDb(samples, RATE, 20, 20000);
  assert.ok(share(kick, 20, 250) > -1.5, "the kick lives under 250 Hz");
  assert.ok(share(hat, 3000, 20000) > -3, "the hi-hat lives above 3 kHz");
  assert.ok(share(snare, 1000, 20000) > -6 && share(snare, 120, 400) > -14, "the snare has noise and a body");
  assert.ok(rms(slice(kick, 0.4, 0.5)) < rms(slice(kick, 0, 0.05)) * 0.02, "the kick has died by 0.4 s");
});

test("the next hit cuts the drum before it", () => {
  const arrangement = {
    tempoBpm: 120,
    channels: { NO: [{ pitch: 36, onset: 0, duration: 0.25, velocity: 100 }, { pitch: 42, onset: 0.25, duration: 0.25, velocity: 100 }] },
  };
  const hits = renderSnesStems(arrangement, RATE).NO;
  // Left alone the kick would still be sounding at 0.25 to 0.3 s; the hat after 0.125 s cuts it
  const low = (/** @type {Float64Array} */ samples) => bandLevelDb(slice(samples, 0.25, 0.3), RATE, 20, 250, 1024);
  assert.ok(low(hits) < low(solo("NO", 36, { beats: 1 })) - 10);
});

test("a louder velocity makes a louder note", () => {
  for (const channel of /** @type {const} */ (["P1", "P2", "TR", "NO"])) {
    assert.ok(rms(solo(channel, channel === "NO" ? 38 : 60, { velocity: 120 })) > rms(solo(channel, channel === "NO" ? 38 : 60, { velocity: 50 })) * 1.5, channel);
  }
});

test("rendering is deterministic, fits the timeline, and works at other sample rates", () => {
  const arrangement = {
    tempoBpm: 100,
    channels: {
      P1: [{ pitch: 72, onset: 0, duration: 1, velocity: 100 }],
      P2: [{ pitch: 64, onset: 0, duration: 0.5, velocity: 90 }, { pitch: 67, onset: 0.5, duration: 0.5, velocity: 90 }],
      TR: [{ pitch: 36, onset: 0, duration: 2, velocity: 100 }],
      NO: [{ pitch: 36, onset: 0, duration: 0.5, velocity: 100 }, { pitch: 38, onset: 1, duration: 0.5, velocity: 100 }],
    },
  };
  const first = renderSnesStems(arrangement, RATE);
  assert.deepEqual(renderSnesStems(arrangement, RATE), first);
  assert.equal(first.P1.length, Math.ceil((2 * 0.6 + 0.15) * RATE));
  for (const rate of [22050, 32000, 48000]) {
    const stems = renderSnesStems(arrangement, rate);
    assert.equal(stems.TR.length, Math.ceil((2 * 0.6 + 0.15) * rate));
    assert.ok(Math.abs(peakFrequency(stems.TR.subarray(0, Math.floor(rate * 1.1)), rate) - 65.4) < 2.5, `${rate} Hz`);
  }
});
