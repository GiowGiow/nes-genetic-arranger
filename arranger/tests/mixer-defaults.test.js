// @ts-check
// The measurement behind the mixer's default levels (spec 005: FR-003, SC-001, research R1).
//
// Each of the page's 8 examples (seed 1, its committed plan fixture) is rendered as NES stems,
// and each stem's gated loudness (`gatedRms`) is compared with P1's: the gap, in dB. The
// defaults come from the gaps averaged over the songs: P2 sits 1 dB under P1, and TR and NO
// 3 dB under it, rounded to 0.5 dB. Only the differences between channels matter (the page
// scales the whole mix afterwards), so when the loudest default would pass MAX_DB, all of them
// move down together.
//
// The test prints the gaps (`node --test tests/mixer-defaults.test.js`), checks that
// DEFAULT_LEVELS are the levels the measurement gives, and that with them the harmony, the bass
// and the drums are within 4 dB of the melody in every example (SC-001). Research R1 records
// the numbers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SAMPLE_RATE } from "../src/audio/chip-synth.js";
import { gatedRms } from "../src/audio/loudness.js";
import { DEFAULT_LEVELS, MAX_DB, dbToGain } from "../src/audio/mixer.js";
import { renderPackStems } from "../src/audio/sound-packs.js";
import { buildExamples } from "../src/ui/examples.js";
import { readFixture, repoRoot } from "./helpers.js";

/** @typedef {"P2" | "TR" | "NO"} OtherChannel */

/** @type {OtherChannel[]} */
const OTHERS = ["P2", "TR", "NO"];

// Where each channel should sit under P1, in dB of gated loudness (research R1): the harmony
// just under the melody, the bass and the drums a little further down.
const TARGET_GAPS_DB = { P2: -1, TR: -3, NO: -3 };

// SC-001: with the defaults, every channel is this close to the melody.
const LARGEST_GAP_DB = 4;

/** @param {number} level a linear amplitude */
const toDb = (level) => 20 * Math.log10(level);

/** @param {number} db */
const toHalfDb = (db) => Math.round(db * 2) / 2;

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
 * The gaps of every example, before (every channel at the chip's own balance) and after the
 * default levels. Rendered once for both tests; the stems are not kept.
 * @type {Array<{id: string, before: Record<OtherChannel, number>, after: Record<OtherChannel, number>}> | undefined}
 */
let measured;
function measureExamples() {
  if (measured) return measured;
  const sources = JSON.parse(readFileSync(join(repoRoot, "data/sources.json"), "utf8"));
  const unity = { P1: 1, P2: 1, TR: 1, NO: 1 };
  const defaults = { P1: dbToGain(DEFAULT_LEVELS.P1), P2: dbToGain(DEFAULT_LEVELS.P2), TR: dbToGain(DEFAULT_LEVELS.TR), NO: dbToGain(DEFAULT_LEVELS.NO) };
  measured = buildExamples(sources).map(({ id }) => {
    const stems = renderPackStems("nes", exampleArrangement(id), SAMPLE_RATE);
    return { id, before: gapsToP1(stems, unity), after: gapsToP1(stems, defaults) };
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

test("the default levels put P2 1 dB and TR and NO 3 dB under P1, averaged over the 8 examples", (t) => {
  const examples = measureExamples();
  assert.equal(examples.length, 8);
  for (const { id, before } of examples) t.diagnostic(`gaps to P1 before, ${id}: ${formatGaps(before)} dB`);
  const before = meanGaps(examples.map((example) => example.before));
  t.diagnostic(`mean gaps to P1 before: ${formatGaps(before)} dB`);

  // Each channel's offset from P1, rounded; then all of them moved down if one passes MAX_DB.
  const offsets = { P1: 0, P2: toHalfDb(TARGET_GAPS_DB.P2 - before.P2), TR: toHalfDb(TARGET_GAPS_DB.TR - before.TR), NO: toHalfDb(TARGET_GAPS_DB.NO - before.NO) };
  const shift = Math.min(0, MAX_DB - Math.max(...Object.values(offsets)));
  const expected = { P1: offsets.P1 + shift, P2: offsets.P2 + shift, TR: offsets.TR + shift, NO: offsets.NO + shift };
  t.diagnostic(`measured defaults: ${JSON.stringify(expected)} dB`);

  const { P1, P2, TR, NO } = DEFAULT_LEVELS;
  assert.deepEqual({ P1, P2, TR, NO }, expected);
});

test("with the default levels the harmony, the bass and the drums are within 4 dB of the melody in every example (SC-001)", (t) => {
  const examples = measureExamples();
  t.diagnostic(`mean gaps to P1 after: ${formatGaps(meanGaps(examples.map((example) => example.after)))} dB`);
  for (const { id, after } of examples) {
    t.diagnostic(`gaps to P1 after, ${id}: ${formatGaps(after)} dB`);
    for (const channel of OTHERS) {
      assert.ok(Math.abs(after[channel]) <= LARGEST_GAP_DB, `${id}: ${channel} is ${after[channel].toFixed(2)} dB from P1`);
    }
  }
});
