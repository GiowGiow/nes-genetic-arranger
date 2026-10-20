// @ts-check
// Tests for audio/sound-packs.js: the same arrangement played with the sound of other chips.
//
// Every pack must keep the timeline of the NES chip render (same length, notes at the same
// seconds), so the A/B player can switch packs without moving. The tests check that, and the
// small facts each pack's sound rests on: pulse duty cycles, the Game Boy's 4-bit wave, the
// Commodore 64's sawtooth.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CHANNEL_GAINS, PEAK_LEVEL, renderChip, renderChipStems, renderLength } from "../src/audio/chip-synth.js";
import { SOUND_PACKS, WAVES, arrangementVoices, renderPack, renderPackStems } from "../src/audio/sound-packs.js";
import { readFixture } from "./helpers.js";

const RATE = 22050;

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

/** @param {Float32Array} samples */
const peakOf = (samples) => samples.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);

test("the five packs come in order, NES chip first, each with a name and a description", () => {
  assert.deepEqual(
    SOUND_PACKS.map((pack) => pack.id),
    ["nes", "gameboy", "c64", "soft", "plain"],
  );
  assert.deepEqual(
    SOUND_PACKS.map((pack) => pack.name),
    ["NES chip", "Game Boy", "Commodore 64", "Soft synth", "Plain"],
  );
  for (const pack of SOUND_PACKS) assert.ok(pack.description.length > 20, pack.id);
});

test("the NES chip pack is the chip synthesizer itself", () => {
  const arrangement = korobeiniki();

  assert.deepEqual(renderPack("nes", arrangement, RATE), renderChip(arrangement, RATE));
});

test("renderLength gives the length of the chip render", () => {
  const arrangement = korobeiniki();

  assert.equal(renderLength(arrangement, RATE), renderChip(arrangement, RATE).length);
});

test("every pack plays the same timeline, is not silent and peaks at -3 dBFS at most", () => {
  const arrangement = korobeiniki();
  const length = renderLength(arrangement, RATE);
  for (const pack of SOUND_PACKS) {
    const samples = renderPack(pack.id, arrangement, RATE);
    assert.equal(samples.length, length, pack.id);
    const peak = peakOf(samples);
    assert.ok(peak > 0.1, `${pack.id} is silent`);
    assert.ok(peak <= PEAK_LEVEL + 1e-6, `${pack.id} peaks at ${peak}`);
  }
});

test("a pack gives the same samples every time, and each pack sounds different", () => {
  const arrangement = korobeiniki();
  const renders = SOUND_PACKS.map((pack) => renderPack(pack.id, arrangement, RATE));
  SOUND_PACKS.forEach((pack, index) => {
    assert.deepEqual(renderPack(pack.id, arrangement, RATE), renders[index], pack.id);
  });
  for (let a = 0; a < renders.length; a++) {
    for (let b = a + 1; b < renders.length; b++) {
      assert.notDeepEqual(renders[a], renders[b], `${SOUND_PACKS[a].id} = ${SOUND_PACKS[b].id}`);
    }
  }
});

test("a note starts at the same second in every pack", () => {
  // One melody note on beat 2 at 120 BPM: silence until 1 s, then sound.
  const arrangement = { tempoBpm: 120, channels: { P1: [{ pitch: 69, onset: 2, duration: 1, velocity: 100 }] } };
  for (const pack of SOUND_PACKS) {
    const samples = renderPack(pack.id, arrangement, RATE);
    const before = samples.subarray(0, Math.floor(0.99 * RATE));
    const during = samples.subarray(Math.floor(1.05 * RATE), Math.floor(1.4 * RATE));
    assert.equal(peakOf(before), 0, `${pack.id} sounds before the note`);
    assert.ok(peakOf(during) > 0.1, `${pack.id} is silent during the note`);
  }
});

test("an arrangement without notes is silence as long as the chip render", () => {
  const empty = { tempoBpm: 120, channels: {} };
  for (const pack of SOUND_PACKS) {
    const samples = renderPack(pack.id, empty, RATE);
    assert.equal(samples.length, renderChip(empty, RATE).length, pack.id);
    assert.equal(peakOf(samples), 0, pack.id);
  }
});

test("an unknown pack is refused by name", () => {
  assert.throws(() => renderPack("amiga", korobeiniki(), RATE), { message: 'unknown sound pack "amiga"' });
});

test("a pulse is high for its duty cycle of each period", () => {
  for (const duty of [0.125, 0.25, 0.5]) {
    const steps = 1000;
    let high = 0;
    for (let i = 0; i < steps; i++) high += WAVES.pulse(i / steps, duty) > 0 ? 1 : 0;
    assert.equal(high / steps, duty);
  }
});

test("the Game Boy wave channel has 32 steps of at most 16 levels", () => {
  const levels = new Set();
  const steps = new Set();
  for (let i = 0; i < 640; i++) {
    const phase = i / 640;
    levels.add(WAVES.gameboyWave(phase));
    steps.add(Math.floor(phase * 32));
  }
  assert.ok(levels.size <= 16, `${levels.size} levels`);
  assert.equal(steps.size, 32);
});

test("the sawtooth rises across each period, and the sine is smooth and odd", () => {
  assert.ok(WAVES.sawtooth(0.1) < WAVES.sawtooth(0.4));
  assert.ok(WAVES.sawtooth(0.4) < WAVES.sawtooth(0.9));
  assert.ok(Math.abs(WAVES.sine(0.25) - 1) < 1e-12);
  assert.ok(Math.abs(WAVES.sine(0.75) + 1) < 1e-12);
});

test("arrangementVoices plays P1 as the melody, P2 and TR as the other voices and NO as drums", () => {
  const voices = arrangementVoices({
    tempoBpm: 120,
    channels: {
      P1: [{ pitch: 72, onset: 0, duration: 1, velocity: 100 }],
      P2: [{ pitch: 60, onset: 0, duration: 2, velocity: 80 }],
      TR: [{ pitch: 36, onset: 0, duration: 4, velocity: 90 }],
      NO: [{ pitch: 36, onset: 0, duration: 0.25, velocity: 100 }],
    },
  });

  assert.deepEqual(voices.melody, [{ pitch: 72, onset: 0, duration: 1 }]);
  assert.deepEqual(voices.others, [[{ pitch: 60, onset: 0, duration: 2 }], [{ pitch: 36, onset: 0, duration: 4 }]]);
  assert.deepEqual(voices.drums, [{ pitch: 36, onset: 0 }]);
});

test("every pack renders the Korobeiniki sample in under a second", () => {
  const arrangement = korobeiniki();
  for (const pack of SOUND_PACKS) {
    const start = performance.now();
    renderPack(pack.id, arrangement, 44100);
    const seconds = (performance.now() - start) / 1000;
    assert.ok(seconds < 1, `${pack.id} took ${seconds.toFixed(2)} s`);
  }
});

// --- Stems (spec 005): one track per channel, so the page can set each channel's level live ---

/** @type {Array<"P1" | "P2" | "TR" | "NO">} */
const CHANNELS = ["P1", "P2", "TR", "NO"];

/** One bar where every channel plays, drum hits included. */
const BAND = {
  tempoBpm: 120,
  channels: {
    P1: [{ pitch: 76, onset: 0, duration: 2, velocity: 100 }, { pitch: 72, onset: 2, duration: 2, velocity: 100 }],
    P2: [{ pitch: 64, onset: 0, duration: 4, velocity: 80 }],
    TR: [{ pitch: 45, onset: 0, duration: 4, velocity: 100 }],
    NO: [{ pitch: 36, onset: 0, duration: 0.5, velocity: 100 }, { pitch: 38, onset: 2, duration: 0.5, velocity: 90 }],
  },
};

/**
 * The largest difference between two renders of the same length.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 */
function largestDifference(a, b) {
  assert.equal(a.length, b.length);
  let largest = 0;
  for (let i = 0; i < a.length; i++) largest = Math.max(largest, Math.abs(a[i] - b[i]));
  return largest;
}

/**
 * The four stems added sample by sample.
 * @param {Record<string, Float32Array>} stems
 */
function sumOf(stems) {
  const sum = new Float64Array(stems.P1.length);
  for (const channel of CHANNELS) stems[channel].forEach((sample, i) => (sum[i] += sample));
  return sum;
}

test("every pack gives four stems, P1, P2, TR and NO, as long as its render", () => {
  const arrangement = korobeiniki();
  const length = renderLength(arrangement, RATE);
  for (const pack of SOUND_PACKS) {
    const stems = renderPackStems(pack.id, arrangement, RATE);
    assert.deepEqual(Object.keys(stems).sort(), [...CHANNELS].sort(), pack.id);
    for (const channel of CHANNELS) {
      assert.ok(stems[channel] instanceof Float32Array, `${pack.id} ${channel}`);
      assert.equal(stems[channel].length, length, `${pack.id} ${channel}`);
      assert.ok(peakOf(stems[channel]) > 0, `${pack.id} ${channel} is silent`);
    }
  }
});

test("in every pack each stem holds only its own channel's notes", () => {
  // For the plain pack this is its own mapping: the melody voice is P1, the first other voice
  // P2, the second TR, and the drum hits NO.
  for (const pack of SOUND_PACKS) {
    for (const channel of CHANNELS) {
      const solo = { tempoBpm: BAND.tempoBpm, channels: { [channel]: BAND.channels[channel] } };
      const stems = renderPackStems(pack.id, solo, RATE);
      for (const other of CHANNELS) {
        if (other === channel) assert.ok(peakOf(stems[other]) > 0.01, `${pack.id}: ${channel} is silent`);
        else assert.equal(peakOf(stems[other]), 0, `${pack.id}: ${channel} leaks into ${other}`);
      }
    }
  }
});

test("the stems of a pack add up to its render, so at 0 dB the mix sounds the same", () => {
  const arrangement = korobeiniki();
  for (const pack of SOUND_PACKS) {
    const difference = largestDifference(sumOf(renderPackStems(pack.id, arrangement, RATE)), renderPack(pack.id, arrangement, RATE));
    assert.ok(difference < 1e-5, `${pack.id}: largest difference ${difference}`);
  }
});

test("the NES stems are the chip's stems times the chip's channel gains, scaled like the render", () => {
  const arrangement = korobeiniki();
  const chip = renderChipStems(arrangement, RATE);
  const nes = renderPackStems("nes", arrangement, RATE);
  // renderChip's scale: -3 dBFS over the peak of the chip stems mixed with the chip's gains.
  const mixed = new Float64Array(chip.P1.length);
  for (const channel of CHANNELS) chip[channel].forEach((sample, i) => (mixed[i] += CHANNEL_GAINS[channel] * sample));
  const scale = PEAK_LEVEL / mixed.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0);
  for (const channel of CHANNELS) {
    const expected = Float32Array.from(chip[channel], (sample) => sample * CHANNEL_GAINS[channel] * scale);
    const difference = largestDifference(nes[channel], expected);
    assert.ok(difference < 1e-6, `${channel}: largest difference ${difference}`);
  }
});

test("an unknown pack has no stems either", () => {
  assert.throws(() => renderPackStems("amiga", korobeiniki(), RATE), { message: 'unknown sound pack "amiga"' });
});

test("an arrangement without notes gives silent stems in every pack", () => {
  const empty = { tempoBpm: 120, channels: {} };
  for (const pack of SOUND_PACKS) {
    const stems = renderPackStems(pack.id, empty, RATE);
    for (const channel of CHANNELS) {
      assert.equal(stems[channel].length, renderLength(empty, RATE), `${pack.id} ${channel}`);
      assert.equal(peakOf(stems[channel]), 0, `${pack.id} ${channel}`);
    }
  }
});
