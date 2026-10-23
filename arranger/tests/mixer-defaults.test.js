// @ts-check
// The measurement behind the mixer's default levels (spec 005: FR-003, research R1).
//
// Each of the page's 8 examples (seed 1, its committed plan fixture) is rendered as NES stems,
// and each stem's gated loudness (`gatedRms`) is compared with P1's: the gap, in dB. The test
// prints the gaps at the chip's own balance (before) and with DEFAULT_LEVELS (after), so the
// numbers in research R1 can be checked with `node --test tests/mixer-defaults.test.js`.
//
// The defaults are perceptual, not the result of a formula. Gated RMS weighs every frequency the
// same, but the ear (and a laptop speaker even more) hears the triangle bass, at 41 to 155 Hz,
// as much softer than its RMS says. So the measured gaps cannot pick the levels; they bound
// them. The tests encode the intent of the defaults on every example:
//
// - the bass sits near the melody's measured loudness or above it (between -2 and +7 dB), so a
//   speaker that drops low frequencies still lets it through;
// - the drums, which measure 17 to 19 dB under the melody at the chip's balance, come at least
//   8 dB closer;
// - the default mix, scaled to -3 dBFS as the WAV download is, never clips.
//
// The student confirms the defaults by ear (research R1).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SAMPLE_RATE } from "../src/audio/chip-synth.js";
import { gatedRms } from "../src/audio/loudness.js";
import { DEFAULT_LEVELS, channelGains, defaultLevels, mixStems } from "../src/audio/mixer.js";
import { SOUND_PACKS, renderPackStems } from "../src/audio/sound-packs.js";
import { buildExamples } from "../src/ui/examples.js";
import { readFixture, repoRoot } from "./helpers.js";

/** @typedef {"P2" | "TR" | "NO"} OtherChannel */

/** @type {OtherChannel[]} */
const OTHERS = ["P2", "TR", "NO"];

// Where the bass may sit against the melody with the defaults, in dB of gated loudness.
const BASS_GAP_RANGE_DB = { lowest: -2, highest: 7 };

// How much closer to the melody the drums must come than at the chip's balance, in dB.
const DRUMS_LIFT_DB = 8;

/** @param {number} level a linear amplitude */
const toDb = (level) => 20 * Math.log10(level);

/**
 * An arrangement of a plan fixture, as the page realizes it.
 * @param {string} exampleId an example id, for example "mulher_de_fases"
 */
function exampleArrangement(exampleId) {
  const plan = readFixture(`plans/${exampleId.replaceAll("_", "-")}-s1.json`);
  const sheet = readFixture(`leadsheets/${exampleId}.json`);
  /** @type {Record<string, Array<{pitch: number, onset: number, duration: number, velocity: number}>>} */
  const channels = {};
  for (const [name, notes] of Object.entries(plan.arrangement)) {
    channels[name] = notes.map((/** @type {number[]} */ [pitch, onset, duration, velocity]) => ({ pitch, onset, duration, velocity }));
  }
  return { tempoBpm: sheet.tempo_bpm, channels };
}

/**
 * Each stem's gap to P1 in dB of gated loudness, with every stem times its gain.
 * @param {Record<string, Float32Array>} stems
 * @param {Record<string, number>} gains
 * @returns {Record<OtherChannel, number>}
 */
function gapsToP1(stems, gains) {
  const scaled = new Float32Array(stems.P1.length);
  const levelOf = (/** @type {string} */ channel) => {
    const stem = stems[channel];
    for (let i = 0; i < stem.length; i++) scaled[i] = stem[i] * gains[channel];
    return toDb(gatedRms(scaled, SAMPLE_RATE));
  };
  const p1 = levelOf("P1");
  return { P2: levelOf("P2") - p1, TR: levelOf("TR") - p1, NO: levelOf("NO") - p1 };
}

/**
 * @param {ArrayLike<number>} samples
 * @returns {number} the largest absolute sample
 */
function peakOf(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  return peak;
}

/**
 * The gaps of every example, before (every channel at the chip's own balance) and after the
 * default levels, and the peak of the default mix. Rendered once for all tests; the stems are
 * not kept.
 * @type {Array<{id: string, before: Record<OtherChannel, number>, after: Record<OtherChannel, number>, mixPeak: number}> | undefined}
 */
let measured;
function measureExamples() {
  if (measured) return measured;
  const sources = JSON.parse(readFileSync(join(repoRoot, "data/sources.json"), "utf8"));
  const unity = { P1: 1, P2: 1, TR: 1, NO: 1 };
  const defaults = channelGains(DEFAULT_LEVELS);
  measured = buildExamples(sources).map(({ id }) => {
    const stems = renderPackStems("nes", exampleArrangement(id), SAMPLE_RATE);
    return {
      id,
      before: gapsToP1(stems, unity),
      after: gapsToP1(stems, defaults),
      mixPeak: peakOf(mixStems(stems, DEFAULT_LEVELS)),
    };
  });
  return measured;
}

/**
 * The mean of each channel's gap over the examples.
 * @param {Array<Record<OtherChannel, number>>} gaps
 * @returns {Record<OtherChannel, number>}
 */
function meanGaps(gaps) {
  const mean = (/** @type {OtherChannel} */ channel) => gaps.reduce((sum, gap) => sum + gap[channel], 0) / gaps.length;
  return { P2: mean("P2"), TR: mean("TR"), NO: mean("NO") };
}

/** @param {Record<OtherChannel, number>} gaps */
const formatGaps = (gaps) => OTHERS.map((channel) => `${channel} ${gaps[channel].toFixed(2)}`).join(", ");

test("the gaps to the melody are measured on the 8 examples, at the chip's balance and with the defaults", (t) => {
  const examples = measureExamples();
  assert.equal(examples.length, 8);
  const { P1, P2, TR, NO } = DEFAULT_LEVELS;
  t.diagnostic(`default levels: ${JSON.stringify({ P1, P2, TR, NO })} dB`);
  for (const { id, before, after } of examples) {
    t.diagnostic(`${id}: before ${formatGaps(before)} dB; after ${formatGaps(after)} dB`);
  }
  t.diagnostic(`mean before: ${formatGaps(meanGaps(examples.map((example) => example.before)))} dB`);
  t.diagnostic(`mean after: ${formatGaps(meanGaps(examples.map((example) => example.after)))} dB`);
  for (const { id, before, after } of examples) {
    for (const channel of OTHERS) {
      assert.ok(Number.isFinite(before[channel]) && Number.isFinite(after[channel]), `${id}: ${channel} has a level`);
    }
  }
});

test("with the defaults the bass sits between 2 dB under and 7 dB over the melody in every example", () => {
  const { lowest, highest } = BASS_GAP_RANGE_DB;
  for (const { id, after } of measureExamples()) {
    assert.ok(after.TR >= lowest && after.TR <= highest, `${id}: TR is ${after.TR.toFixed(2)} dB from P1`);
  }
});

test("with the defaults the drums come at least 8 dB closer to the melody than at the chip's balance", () => {
  for (const { id, before, after } of measureExamples()) {
    const lift = after.NO - before.NO;
    assert.ok(lift >= DRUMS_LIFT_DB, `${id}: NO comes ${lift.toFixed(2)} dB closer (from ${before.NO.toFixed(2)} to ${after.NO.toFixed(2)} dB)`);
  }
});

test("the default mix, scaled to -3 dBFS like the WAV download, never clips", (t) => {
  for (const { id, mixPeak } of measureExamples()) {
    t.diagnostic(`${id}: default mix peaks at ${toDb(mixPeak).toFixed(2)} dBFS`);
    assert.ok(mixPeak > 0 && mixPeak < 1, `${id}: peak ${mixPeak}`);
  }
});

/**
 * Weight a signal like the ear, with the two filters of ITU-R BS.1770 (K-weighting): a high shelf
 * of +4 dB above 1.7 kHz that models the head, and a high-pass at 38 Hz. Coefficients by the
 * bilinear transform, as the recommendation gives them.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @returns {Float32Array}
 */
function kWeighted(samples, sampleRate) {
  /**
   * @param {ArrayLike<number>} input
   * @param {number[]} b numerator
   * @param {number[]} a the two feedback terms (a0 is 1)
   */
  const biquad = (input, b, a) => {
    const output = new Float32Array(input.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < input.length; i++) {
      const y = b[0] * input[i] + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
      x2 = x1; x1 = input[i]; y2 = y1; y1 = y;
      output[i] = y;
    }
    return output;
  };
  const shelf = { f0: 1681.974450955533, gain: 3.999843853973347, q: 0.7071752369554196 };
  let k = Math.tan((Math.PI * shelf.f0) / sampleRate);
  const vh = 10 ** (shelf.gain / 20);
  const vb = vh ** 0.4996667741545416;
  const a0 = 1 + k / shelf.q + k * k;
  const shelved = biquad(
    samples,
    [(vh + (vb * k) / shelf.q + k * k) / a0, (2 * (k * k - vh)) / a0, (vh - (vb * k) / shelf.q + k * k) / a0],
    [(2 * (k * k - 1)) / a0, (1 - k / shelf.q + k * k) / a0],
  );
  k = Math.tan((Math.PI * 38.13547087602444) / sampleRate);
  const q = 0.5003270373238773;
  const a0b = 1 + k / q + k * k;
  return biquad(shelved, [1, -2, 1], [(2 * (k * k - 1)) / a0b, (1 - k / q + k * k) / a0b]);
}

/**
 * The mean gaps of one sound pack on the 8 examples, measured in one pass over its renders (a
 * render is the slow part, and two tests need numbers from the same one): the unweighted gaps to
 * the melody at the pack's own balance (`before`) and with its default levels (`after`), and the
 * K-weighted gaps with its default levels (`weighted`).
 * @type {Map<string, {before: Record<OtherChannel, number>, after: Record<OtherChannel, number>, weighted: Record<OtherChannel, number>}>}
 */
const measuredPacks = new Map();

/** @param {string} packId */
function measurePack(packId) {
  const known = measuredPacks.get(packId);
  if (known) return known;
  const sources = JSON.parse(readFileSync(join(repoRoot, "data/sources.json"), "utf8"));
  const examples = buildExamples(sources);
  const unity = { P1: 1, P2: 1, TR: 1, NO: 1 };
  const gains = channelGains(defaultLevels(packId));
  const before = [];
  const after = [];
  const mean = { P2: 0, TR: 0, NO: 0 };
  for (const { id } of examples) {
    const stems = renderPackStems(packId, exampleArrangement(id), SAMPLE_RATE);
    before.push(gapsToP1(stems, unity));
    after.push(gapsToP1(stems, gains));
    const levelOf = (/** @type {"P1" | OtherChannel} */ channel) => {
      const weighted = kWeighted(stems[channel], SAMPLE_RATE);
      for (let i = 0; i < weighted.length; i++) weighted[i] *= gains[channel];
      return toDb(gatedRms(weighted, SAMPLE_RATE));
    };
    const melody = levelOf("P1");
    for (const channel of OTHERS) mean[channel] += (levelOf(channel) - melody) / examples.length;
  }
  const measured = { before: meanGaps(before), after: meanGaps(after), weighted: mean };
  measuredPacks.set(packId, measured);
  return measured;
}

test("every sound pack's own defaults bring the drums closer to the melody, keep the bass near it and the harmony under it", (t) => {
  for (const pack of SOUND_PACKS) {
    const { before: was, after: now } = measurePack(pack.id);
    t.diagnostic(`${pack.id}: before ${formatGaps(was)} dB; with its defaults ${formatGaps(now)} dB`);
    assert.ok(now.NO - was.NO >= 4.5, `${pack.id}: the drums come at least 4.5 dB closer`);
    assert.ok(now.TR >= -6 && now.TR <= 7, `${pack.id}: the bass is between 6 dB under and 7 dB over the melody (${now.TR.toFixed(1)})`);
    assert.ok(now.P2 <= 0 && now.P2 >= -8, `${pack.id}: the harmony sits under the melody (${now.P2.toFixed(1)})`);
  }
});

test("the defaults of every pack but Plain bring its K-weighted gaps to the raw chip's: harmony -5.5, bass +1.5 and drums -7.3 dB from the melody", (t) => {
  const reference = { P2: -5.5, TR: 1.5, NO: -7.3 };
  for (const pack of SOUND_PACKS) {
    if (pack.id === "plain") continue; // its drums were lowered by ear and its bass held at 10 dB
    const { weighted } = measurePack(pack.id);
    t.diagnostic(`${pack.id}: K-weighted gaps ${formatGaps(weighted)} dB`);
    for (const channel of OTHERS) {
      assert.ok(Math.abs(weighted[channel] - reference[channel]) <= 1.7, `${pack.id} ${channel}: ${weighted[channel].toFixed(2)} dB, the chip's is ${reference[channel]}`);
    }
  }
});
