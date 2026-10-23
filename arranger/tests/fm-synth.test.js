// @ts-check
// Tests for audio/fm-synth.js: the four-operator FM voice of the Mega Drive pack.
//
// They read as the rules of FM synthesis: an operator is a sine; a carrier alone is a pure tone at
// the note's frequency (times its multiple); a modulator bends the carrier's phase and so adds
// partials, more of them the stronger it is; feedback does the same to an operator by itself; the
// envelope of an operator falls in dB at a steady rate.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALGORITHMS,
  FEEDBACK_RADIANS,
  attenuationDb,
  envelopeGain,
  fmOperator,
  renderFmNote,
} from "../src/audio/fm-synth.js";
import { bandLevelDb, peakFrequency } from "./spectrum.js";

const RATE = 44100;

/** An operator that is silent (96 dB down): the chip's way to switch one off. */
const OFF = fmOperator({ totalLevel: 96 });

/**
 * A patch where only the operators listed in `on` make sound, all with a flat envelope.
 * @param {number} algorithm
 * @param {Array<Partial<Parameters<typeof fmOperator>[0]>>} operators four partial operator settings
 * @param {number} [feedback]
 */
function patch(algorithm, operators, feedback = 0) {
  return { algorithm, feedback, operators: [0, 1, 2, 3].map((index) => (operators[index] ? fmOperator(operators[index]) : OFF)) };
}

/** @param {ReturnType<typeof patch>} p @param {number} hz @param {number} [seconds] */
const render = (p, hz, seconds = 1) => renderFmNote(p, { frequency: hz, seconds, velocity: 127 }, RATE);

test("the eight algorithms feed each operator only from lower-numbered ones, and have 1, 1, 1, 1, 2, 3, 3 and 4 carriers", () => {
  assert.equal(ALGORITHMS.length, 8);
  ALGORITHMS.forEach(({ inputs, carriers }, index) => {
    inputs.forEach((sources, operator) => {
      for (const source of sources) assert.ok(source < operator, `algorithm ${index}: operator ${operator} fed by ${source}`);
    });
    assert.ok(carriers.every((operator) => operator >= 0 && operator < 4));
  });
  assert.deepEqual(
    ALGORITHMS.map((algorithm) => algorithm.carriers.length),
    [1, 1, 1, 1, 2, 3, 3, 4],
  );
  assert.deepEqual(ALGORITHMS[0].inputs, [[], [0], [1], [2]], "algorithm 0 is the serial chain 1 > 2 > 3 > 4");
  assert.deepEqual(ALGORITHMS[7].inputs, [[], [], [], []], "algorithm 7 is four carriers in parallel");
});

test("feedback grows from none to 4π radians in 8 steps", () => {
  assert.equal(FEEDBACK_RADIANS.length, 8);
  assert.equal(FEEDBACK_RADIANS[0], 0);
  assert.ok(Math.abs(FEEDBACK_RADIANS[7] - 4 * Math.PI) < 1e-12);
  for (let i = 1; i < 8; i++) assert.ok(FEEDBACK_RADIANS[i] > FEEDBACK_RADIANS[i - 1]);
});

test("a patch with one carrier and nothing else is a sine at the note's frequency", () => {
  const samples = render(patch(7, [{}]), 440, 0.5);
  for (let i = 0; i < 4000; i++) {
    assert.ok(Math.abs(samples[i] - Math.sin((2 * Math.PI * 440 * i) / RATE)) < 1e-6, `sample ${i}`);
  }
  assert.ok(Math.abs(peakFrequency(samples.subarray(0, 32768), RATE) - 440) < 1);
});

test("an operator's multiple sets its frequency as a multiple of the note's, and its detune moves it by cents", () => {
  const twice = render(patch(7, [{ multiple: 2 }]), 220, 0.8);
  assert.ok(Math.abs(peakFrequency(twice.subarray(0, 32768), RATE) - 440) < 1);
  const sharp = render(patch(7, [{ detuneCents: 1200 }]), 220, 0.8);
  assert.ok(Math.abs(peakFrequency(sharp.subarray(0, 32768), RATE) - 440) < 1, "1200 cents is an octave");
});

test("a modulator adds partials to its carrier, more of them the stronger it is", () => {
  const weak = render(patch(4, [{ totalLevel: 40 }, {}]), 440);
  const strong = render(patch(4, [{ totalLevel: 8 }, {}]), 440);
  const none = render(patch(4, [{ totalLevel: 96 }, {}]), 440);
  const partials = (/** @type {Float64Array} */ samples) => bandLevelDb(samples, RATE, 600, 8000);
  assert.ok(partials(none) < -80, "no modulation: a pure sine has nothing above its fundamental");
  assert.ok(partials(weak) > partials(none) + 40);
  assert.ok(partials(strong) > partials(weak) + 15, `strong ${partials(strong).toFixed(1)} dB, weak ${partials(weak).toFixed(1)} dB`);
  assert.ok(Math.abs(peakFrequency(weak.subarray(0, 32768), RATE) - 440) < 5, "the pitch stays the note's");
});

test("a modulator at the same frequency as its carrier makes harmonics, and one at a non-integer multiple makes inharmonic partials", () => {
  const harmonic = render(patch(4, [{ totalLevel: 10 }, {}]), 400);
  const bell = render(patch(4, [{ totalLevel: 10, multiple: 1.41 }, {}]), 400);
  // Harmonics lie at multiples of 400 Hz: 800 Hz holds energy, 1000 Hz (2.5 ×) does not
  const bins = (/** @type {Float64Array} */ samples, /** @type {number} */ hz) => bandLevelDb(samples, RATE, hz - 40, hz + 40);
  assert.ok(bins(harmonic, 800) > bins(harmonic, 1000) + 20);
  assert.ok(bins(bell, 1000) > bins(harmonic, 1000) + 10, "sidebands at 400 ± 1.41 × 400 are not multiples of 400");
});

test("feedback on the first operator turns its sine toward a sawtooth: it adds partials without another operator", () => {
  const plain = render(patch(7, [{}], 0), 220);
  const feedback = render(patch(7, [{}], 6), 220);
  assert.ok(bandLevelDb(plain, RATE, 400, 8000) < -80);
  assert.ok(bandLevelDb(feedback, RATE, 400, 8000) > bandLevelDb(plain, RATE, 400, 8000) + 50);
});

test("an envelope rises over its attack, then falls at its decay rate in dB per second", () => {
  const op = fmOperator({ attack: 0.1, decay1Rate: 20 });
  assert.ok(envelopeGain(op, 0) < 0.02, "starts near silence");
  assert.ok(envelopeGain(op, 0.05) > envelopeGain(op, 0.01), "rises");
  assert.ok(envelopeGain(op, 0.05) < 1);
  assert.ok(Math.abs(envelopeGain(op, 0.1) - 1) < 0.02, "full level when the attack ends");
  // After the attack the attenuation grows 20 dB per second
  assert.ok(Math.abs(attenuationDb(op, 0.6) - 10) < 0.2, `${attenuationDb(op, 0.6)} dB at 0.5 s into the decay`);
  assert.ok(Math.abs(envelopeGain(op, 0.6) - 10 ** (-10 / 20)) < 0.01);
});

test("the second decay takes over at the sustain level, and the release starts from wherever the note was", () => {
  const op = fmOperator({ attack: 0, decay1Rate: 40, sustainLevel: 12, decay2Rate: 4 });
  assert.ok(Math.abs(attenuationDb(op, 0.3) - 12) < 0.1, "decay 1 stops at the sustain level (0.3 s × 40 dB/s)");
  assert.ok(Math.abs(attenuationDb(op, 1.3) - 16) < 0.1, "then decay 2 goes on at 4 dB/s");
  const released = fmOperator({ attack: 0, decay1Rate: 40, sustainLevel: 12, decay2Rate: 4, releaseRate: 100 });
  assert.ok(Math.abs(attenuationDb(released, 1.6, 1.3) - (12 + 4 + 30)) < 0.2, "released at 1.3 s: 16 dB, then 100 dB/s for 0.3 s");
  assert.equal(envelopeGain(released, 10, 0.5), 0, "96 dB down counts as silence");
});

test("an operator with no decay stays at full level, and total level lowers it", () => {
  const flat = fmOperator({});
  assert.equal(envelopeGain(flat, 5), 1);
  const quiet = fmOperator({ totalLevel: 20 });
  assert.ok(Math.abs(attenuationDb(quiet, 1) - 20) < 1e-9);
  assert.ok(Math.abs(envelopeGain(quiet, 1) - 0.1) < 1e-9);
});

test("a note lasts its length plus the release tail, and its release fades to silence", () => {
  const p = patch(7, [{ releaseRate: 200 }]);
  const samples = render(p, 440, 0.5);
  assert.ok(samples.length > 0.5 * RATE, "the tail runs past the note");
  assert.ok(samples.length < 0.5 * RATE + 0.6 * RATE);
  assert.ok(Math.abs(samples[samples.length - 1]) < 0.01);
  const tail = samples.subarray(Math.floor(0.5 * RATE) + 100);
  assert.ok(tail.some((value) => Math.abs(value) > 0.001), "the tail is not cut dead at the note's end");
});

test("velocity scales the carriers' loudness linearly and leaves the modulators alone", () => {
  const p = patch(4, [{ totalLevel: 12 }, {}]);
  const loud = renderFmNote(p, { frequency: 330, seconds: 0.3, velocity: 127 }, RATE);
  const soft = renderFmNote(p, { frequency: 330, seconds: 0.3, velocity: 64 }, RATE);
  for (let i = 0; i < 3000; i += 7) assert.ok(Math.abs(soft[i] - (loud[i] * 64) / 127) < 1e-9);
});

test("vibrato starts after its delay and leaves the pitch where it was", () => {
  const still = patch(7, [{}]);
  const wobbly = { ...still, vibrato: { hz: 6, cents: 50, delay: 0.2 } };
  const a = render(still, 440, 1);
  const b = render(wobbly, 440, 1);
  const delaySamples = Math.floor(0.2 * RATE);
  for (let i = 0; i < delaySamples - 64; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-9, `sample ${i} before the delay`);
  assert.ok(Math.abs(a[RATE / 2] - b[RATE / 2]) > 0.01, "after the delay they differ");
  assert.ok(Math.abs(peakFrequency(b.subarray(8000, 8000 + 32768), RATE) - 440) < 8);
});

test("a pitch envelope starts the note high and settles to its pitch, like a kick drum's thump", () => {
  const p = { ...patch(7, [{}]), pitchEnvelope: { semitones: 24, seconds: 0.05 } };
  const samples = render(p, 100, 0.5);
  /** @param {Float64Array} x @param {number} from @param {number} to */
  const crossings = (x, from, to) => {
    let count = 0;
    for (let i = from + 1; i < to; i++) if (x[i - 1] < 0 && x[i] >= 0) count += 1;
    return count;
  };
  const early = crossings(samples, 0, 441); // the first 10 ms
  const late = crossings(samples, 20000, 20000 + 441);
  assert.ok(early > late * 2, `early ${early} crossings, late ${late}`);
});

test("rendering is deterministic", () => {
  const p = patch(4, [{ totalLevel: 20 }, {}, { totalLevel: 30, multiple: 3 }, {}], 3);
  assert.deepEqual(render(p, 261.63, 0.4), render(p, 261.63, 0.4));
});

test("brightness tracking lowers the modulators of high notes only", () => {
  const plain = patch(4, [{ totalLevel: 10 }, {}]);
  const tracked = { ...plain, brightnessTracking: { fromHz: 300, dbPerOctave: 12 } };
  const above = (/** @type {ReturnType<typeof patch>} */ p, /** @type {number} */ hz) => bandLevelDb(render(p, hz, 0.6), RATE, hz * 1.5, 12000);
  assert.deepEqual(render(tracked, 250, 0.3), render(plain, 250, 0.3), "a note under the reference is untouched");
  assert.ok(above(tracked, 1200) < above(plain, 1200) - 10, "two octaves above: 24 dB less modulation, far fewer partials");
});
