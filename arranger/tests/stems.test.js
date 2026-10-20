// @ts-check
// Tests for the stems of the NES chip render: one track per channel, so the page can set each
// channel's level while it plays (spec 005, story 1, research R2).
//
// The rules: there are four stems (P1, P2, TR, NO), each as long as the render; each holds only
// its own channel, before the chip's channel gains and before the peak scale; mixed with
// CHANNEL_GAINS and scaled to -3 dBFS they give `renderChip`; and `renderChip` itself keeps the
// exact samples it had before stems existed (FR-006), pinned here by their SHA-256.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  CHANNEL_GAINS,
  PEAK_LEVEL,
  SAMPLE_RATE,
  renderChip,
  renderChipStems,
  renderLength,
  scaleToPeak,
} from "../src/audio/chip-synth.js";
import { leadSheetVoices, mixVoices, renderVoices } from "../src/audio/plain-synth.js";
import { leadSheetFromJson } from "../src/core/leadsheet.js";
import { readFixture } from "./helpers.js";

/** @typedef {import("../src/audio/chip-synth.js").ChannelName} ChannelName */

/** @type {ChannelName[]} */
const CHANNELS = ["P1", "P2", "TR", "NO"];

// SHA-256 of the bytes of `renderChip` on the Korobeiniki sample (seed 1) at 44.1 kHz, taken
// before the stems were added. A change here means the chip render changed: update it only on
// purpose, after checking why (the chip parity with the command line depends on it).
const KOROBEINIKI_CHIP_SHA256 = "ed6a464c888b45b6fe52fe46c47239b529a4a5d07859b02c921f5ea274efa1ae";

/** The Korobeiniki sample's arrangement, as the page realizes it (from the plan fixture). */
function korobeiniki() {
  const plan = readFixture("plans/korobeiniki-s1.json");
  const sheet = readFixture("leadsheets/korobeiniki.json");
  /** @type {Record<string, Array<{pitch: number, onset: number, duration: number, velocity: number}>>} */
  const channels = {};
  for (const [name, notes] of Object.entries(plan.arrangement)) {
    channels[name] = notes.map((/** @type {number[]} */ [pitch, onset, duration, velocity]) => ({ pitch, onset, duration, velocity }));
  }
  return { tempoBpm: sheet.tempo_bpm, channels };
}

/** One bar of every channel, drum hits included. */
const BAND = {
  tempoBpm: 140,
  channels: {
    P1: [
      { pitch: 76, onset: 0, duration: 1, velocity: 100 },
      { pitch: 72, onset: 1, duration: 3, velocity: 100 },
    ],
    P2: [{ pitch: 64, onset: 0, duration: 4, velocity: 80 }],
    TR: [{ pitch: 45, onset: 0, duration: 4, velocity: 100 }],
    NO: [
      { pitch: 36, onset: 0, duration: 0.5, velocity: 100 },
      { pitch: 42, onset: 1, duration: 0.5, velocity: 60 },
      { pitch: 38, onset: 2, duration: 0.5, velocity: 90 },
    ],
  },
};

/** @param {ArrayLike<number>} samples */
function peakOf(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  return peak;
}

/**
 * The stems summed with the chip's gains and scaled to peak at -3 dBFS, as renderChip mixes.
 * @param {Record<ChannelName, Float32Array>} stems
 */
function mixWithChipGains(stems) {
  const mix = new Float64Array(stems.P1.length);
  for (const channel of CHANNELS) {
    for (let i = 0; i < mix.length; i++) mix[i] += CHANNEL_GAINS[channel] * stems[channel][i];
  }
  const scale = PEAK_LEVEL / peakOf(mix);
  return Float32Array.from(mix, (sample) => sample * scale);
}

/** @param {Float32Array} samples */
const sha256 = (samples) =>
  createHash("sha256").update(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)).digest("hex");

test("renderChipStems gives the four channels P1, P2, TR and NO, each as long as the render", () => {
  const arrangement = korobeiniki();
  const stems = renderChipStems(arrangement, 22050);

  assert.deepEqual(Object.keys(stems).sort(), [...CHANNELS].sort());
  for (const channel of CHANNELS) {
    assert.ok(stems[channel] instanceof Float32Array, channel);
    assert.equal(stems[channel].length, renderLength(arrangement, 22050), channel);
    assert.ok(peakOf(stems[channel]) > 0, `${channel} is silent`);
  }
});

test("each stem holds only its own channel", () => {
  for (const channel of CHANNELS) {
    const solo = { tempoBpm: 120, channels: { [channel]: BAND.channels[channel] } };
    const stems = renderChipStems(solo, 22050);
    for (const other of CHANNELS) {
      if (other === channel) assert.ok(peakOf(stems[other]) > 0.1, `${channel} is silent`);
      else assert.equal(peakOf(stems[other]), 0, `${channel} leaks into ${other}`);
    }
  }
});

test("stems come before the chip gains and the peak scale: a loud pulse spans -0.5 to 1.5, a triangle -1 to 1", () => {
  // A 25% pulse at full volume is +1 for a quarter of each cycle and -1 for the rest; removing
  // its mean (about -0.5: a note is not a whole number of cycles) moves it to about +1.5 and
  // -0.5. The triangle is centred already, and its chip gain (1.13) is left for the mix.
  const pulse = renderChipStems({ tempoBpm: 120, channels: { P1: [{ pitch: 69, onset: 0, duration: 2, velocity: 127 }] } });
  const triangle = renderChipStems({ tempoBpm: 120, channels: { TR: [{ pitch: 45, onset: 0, duration: 2, velocity: 127 }] } });

  assert.ok(Math.abs(Math.max(...pulse.P1) - 1.5) < 0.002, `pulse top ${Math.max(...pulse.P1)}`);
  assert.ok(Math.abs(Math.min(...pulse.P1) - -0.5) < 0.002, `pulse bottom ${Math.min(...pulse.P1)}`);
  assert.ok(Math.abs(peakOf(triangle.TR) - 1) < 0.002, `triangle peak ${peakOf(triangle.TR)}`);
});

test("the stems mixed with CHANNEL_GAINS and scaled to -3 dBFS give renderChip, to float32 precision", () => {
  for (const [name, arrangement, rate] of /** @type {const} */ ([
    ["band", BAND, SAMPLE_RATE],
    ["korobeiniki", korobeiniki(), 22050],
  ])) {
    const expected = renderChip(arrangement, rate);
    const mixed = mixWithChipGains(renderChipStems(arrangement, rate));
    assert.equal(mixed.length, expected.length, name);
    let largest = 0;
    for (let i = 0; i < expected.length; i++) largest = Math.max(largest, Math.abs(mixed[i] - expected[i]));
    assert.ok(largest < 1e-6, `${name}: largest difference ${largest}`);
  }
});

test("renderChip of the Korobeiniki sample keeps the samples it had before stems (SHA-256 pin)", () => {
  assert.equal(sha256(renderChip(korobeiniki(), 44100)), KOROBEINIKI_CHIP_SHA256);
});

test("an arrangement without notes gives four silent stems of 0.15 s", () => {
  const stems = renderChipStems({ tempoBpm: 120, channels: {} });
  for (const channel of CHANNELS) {
    assert.equal(stems[channel].length, Math.ceil(0.15 * SAMPLE_RATE), channel);
    assert.equal(peakOf(stems[channel]), 0, channel);
  }
});

test("the documented renderChipStems example holds", () => {
  const stems = renderChipStems({ tempoBpm: 120, channels: { P1: [{ pitch: 69, onset: 0, duration: 1, velocity: 100 }] } });
  assert.equal(stems.P1.length, 28665);
  assert.equal(peakOf(stems.P2), 0);
  // Velocity 100 is volume 12 of 15, so the pulse tops out at about 1.5 × 12 / 15 = 1.2.
  assert.ok(Math.abs(Math.max(...stems.P1) - 1.2) < 0.002);
});

test("scaleToPeak puts the largest sample at -3 dBFS and keeps silence silent", () => {
  const scaled = scaleToPeak(Float64Array.of(2, -1, 0));
  assert.ok(scaled instanceof Float32Array);
  assert.deepEqual([...scaled].map((sample) => Math.round(sample * 1e4) / 1e4), [0.7079, -0.354, 0]);
  assert.deepEqual([...scaleToPeak(new Float64Array(3))], [0, 0, 0]);
});

test("plain-synth's mixVoices is renderVoices before the peak scale, so voices mixed apart share one scale", () => {
  const sheet = leadSheetFromJson(readFixture("leadsheets/korobeiniki.json"));
  const voices = leadSheetVoices({ ...sheet, bars: sheet.bars.slice(0, 4) }); // four 4/4 bars
  const mix = mixVoices(voices, 150, 22050, 16);
  assert.ok(mix instanceof Float64Array);
  assert.equal(mix.length, 22050 * 6.4); // 16 beats at 150 BPM: 6.4 s
  const rendered = renderVoices(voices, 150, 22050, 16);
  assert.deepEqual(scaleToPeak(mix), rendered);
  // The melody alone and the pad alone add up to the mix of both.
  const melody = mixVoices({ ...voices, others: [] }, 150, 22050, 16);
  const pad = mixVoices({ ...voices, melody: [] }, 150, 22050, 16);
  let largest = 0;
  for (let i = 0; i < mix.length; i++) largest = Math.max(largest, Math.abs(melody[i] + pad[i] - mix[i]));
  assert.ok(largest < 1e-12, `largest difference ${largest}`);
});
