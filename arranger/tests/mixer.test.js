// @ts-check
// Tests for audio/mixer.js: the visitor's four channel levels, in dB, turned into gains on the
// stems (spec 005, story 1, research R1 to R3).
//
// They read as the rules of the mixer: a level is in dB from -60 (silence) to +12; the defaults
// lift the bass and the drums over the chip's own balance; mute silences a channel at any level;
// the offline mix (for the WAV download) is the stems times their gains, scaled to peak at
// -3 dBFS; the live mix is matched in loudness with the original once, through the bus gain; and
// the levels survive a reload through a storage that may be missing, full or hold anything at
// all.

import { test } from "node:test";
import assert from "node:assert/strict";

import { PEAK_LEVEL, SAMPLE_RATE } from "../src/audio/chip-synth.js";
import { gatedRms, matchLoudness } from "../src/audio/loudness.js";
import {
  CHANNELS,
  DEFAULT_LEVELS,
  PACK_LEVELS,
  defaultLevels,
  MAX_DB,
  MIN_DB,
  MIX_STORAGE_KEY,
  channelGains,
  clampLevels,
  dbToGain,
  matchMixLoudness,
  mixStems,
  readLevels,
  storeLevels,
} from "../src/audio/mixer.js";
import { renderPack, renderPackStems } from "../src/audio/sound-packs.js";

/** @typedef {import("../src/audio/mixer.js").Levels} Levels */

const NOTHING_MUTED = { P1: false, P2: false, TR: false, NO: false };

/** Every channel at 0 dB: the pack's own balance. */
const UNITY = { P1: 0, P2: 0, TR: 0, NO: 0, muted: NOTHING_MUTED };

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
 * Four short stems of constant samples.
 * @param {Record<string, number[]>} values
 */
function stemsOf(values) {
  return {
    P1: Float32Array.from(values.P1),
    P2: Float32Array.from(values.P2),
    TR: Float32Array.from(values.TR),
    NO: Float32Array.from(values.NO),
  };
}

/** A storage like the browser's localStorage, kept in a Map. */
function fakeStorage() {
  const items = new Map();
  return {
    items,
    /** @param {string} key */
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    /** @param {string} key @param {string} value */
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

/** A storage that refuses every read and write, as a browser with storage blocked does. */
const blockedStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

/** @param {number} value */
const round4 = (value) => Math.round(value * 1e4) / 1e4;

test("the mixer has the four channels P1, P2, TR and NO, each from -60 dB to +12 dB", () => {
  assert.deepEqual(CHANNELS, ["P1", "P2", "TR", "NO"]);
  assert.equal(MIN_DB, -60);
  assert.equal(MAX_DB, 12);
  assert.equal(MIX_STORAGE_KEY, "nes-arranger-mix");
});

test("a level in dB becomes a gain: 0 dB keeps the stem, -6 dB halves it, +6 dB doubles it", () => {
  assert.equal(dbToGain(0), 1);
  assert.equal(round4(dbToGain(-6)), 0.5012);
  assert.equal(round4(dbToGain(6)), 1.9953);
  assert.equal(round4(dbToGain(12)), 3.9811);
  assert.equal(round4(dbToGain(-20)), 0.1);
});

test("-60 dB and below are silence, and a muted channel is silent at any level", () => {
  assert.equal(dbToGain(-60), 0);
  assert.equal(dbToGain(-90), 0);
  assert.equal(dbToGain(-Infinity), 0);
  assert.ok(dbToGain(-59.5) > 0);

  const gains = channelGains({ ...UNITY, P2: 6, TR: -60, muted: { ...NOTHING_MUTED, P2: true } });
  assert.deepEqual(gains, { P1: 1, P2: 0, TR: 0, NO: 1 });
});

test("the defaults are those of the NES chip pack: the melody at its balance, the bass 4 dB and the drums 9 dB over (mixer-defaults checks them)", () => {
  const { P1, P2, TR, NO } = DEFAULT_LEVELS;
  assert.deepEqual({ P1, P2, TR, NO }, { P1: 0, P2: 0, TR: 4, NO: 9 });
  for (const channel of CHANNELS) {
    assert.ok(DEFAULT_LEVELS[channel] >= MIN_DB && DEFAULT_LEVELS[channel] <= MAX_DB, channel);
    assert.equal(DEFAULT_LEVELS.muted[channel], false, channel);
  }
  assert.ok(Object.isFrozen(DEFAULT_LEVELS) && Object.isFrozen(DEFAULT_LEVELS.muted));
});

test("every default leaves room to boost: even the drums can go 2 dB higher", () => {
  for (const channel of CHANNELS) assert.ok(MAX_DB - DEFAULT_LEVELS[channel] >= 2, channel);
});

test("clampLevels keeps every level inside [-60, +12] and fills a missing or unreadable one with its default", () => {
  const input = { P1: 20, P2: -100, TR: "loud", muted: { NO: true, P1: "yes" } };
  const clamped = clampLevels(/** @type {any} */ (input));

  assert.deepEqual(clamped, {
    P1: 12,
    P2: -60,
    TR: DEFAULT_LEVELS.TR,
    NO: DEFAULT_LEVELS.NO,
    muted: { P1: false, P2: false, TR: false, NO: true },
  });
  assert.deepEqual(input, { P1: 20, P2: -100, TR: "loud", muted: { NO: true, P1: "yes" } }, "the input is unchanged");
  assert.deepEqual(clampLevels(/** @type {any} */ (null)), clampLevels(DEFAULT_LEVELS));
  assert.deepEqual(clampLevels(DEFAULT_LEVELS), { ...DEFAULT_LEVELS, muted: { ...DEFAULT_LEVELS.muted } });
});

test("mixStems adds the stems times their gains and scales the mix to peak at -3 dBFS", () => {
  const stems = stemsOf({ P1: [0.5, -0.5, 0], P2: [0.25, 0.25, 0], TR: [0, 0, 0.125], NO: [0, 0, 0] });
  // P2 at -6.02 dB is half: the mix is [0.625, -0.375, 0.125], and 0.625 goes to -3 dBFS.
  const mixed = mixStems(stems, { ...UNITY, P2: 20 * Math.log10(0.5) });

  assert.ok(mixed instanceof Float32Array);
  assert.equal(mixed.length, 3);
  const scale = PEAK_LEVEL / 0.625;
  assert.deepEqual([...mixed].map(round4), [0.625 * scale, -0.375 * scale, 0.125 * scale].map(round4));
});

test("a muted channel is left out of the mix, whether the levels or the muted option say so", () => {
  const stems = stemsOf({ P1: [0.5, 0], P2: [0, 0], TR: [0, 0.25], NO: [0, 0] });
  const p1Alone = [0.7079, 0]; // only P1 remains, at -3 dBFS

  assert.deepEqual([...mixStems(stems, { ...UNITY, muted: { ...NOTHING_MUTED, TR: true } })].map(round4), p1Alone);
  assert.deepEqual([...mixStems(stems, UNITY, { muted: { TR: true } })].map(round4), p1Alone);
  assert.deepEqual([...mixStems(stems, { ...UNITY, TR: MIN_DB })].map(round4), p1Alone);
});

test("with every channel muted the mix is silence as long as the stems", () => {
  const stems = stemsOf({ P1: [0.5, 0.1], P2: [0.2, 0.2], TR: [0.1, 0.3], NO: [0.4, 0] });
  const muted = { P1: true, P2: true, TR: true, NO: true };

  assert.deepEqual([...mixStems(stems, { ...UNITY, muted })], [0, 0]);
});

test("at 0 dB on every channel, mixStems of a pack's stems is the pack's render", () => {
  for (const packId of ["nes", "megadrive", "snes", "gameboy", "plain"]) {
    const expected = renderPack(packId, BAND, 22050);
    const mixed = mixStems(renderPackStems(packId, BAND, 22050), UNITY);
    let largest = 0;
    for (let i = 0; i < expected.length; i++) largest = Math.max(largest, Math.abs(mixed[i] - expected[i]));
    assert.ok(largest < 1e-5, `${packId}: largest difference ${largest}`);
  }
});

/**
 * The stems added with the gains of `levels`, before any peak scale: what the player's bus gets.
 * @param {Record<string, Float32Array>} stems
 * @param {Levels} levels
 */
function busInput(stems, levels) {
  const gains = channelGains(levels);
  const sum = new Float32Array(stems.P1.length);
  for (let i = 0; i < sum.length; i++) {
    sum[i] = gains.P1 * stems.P1[i] + gains.P2 * stems.P2[i] + gains.TR * stems.TR[i] + gains.NO * stems.NO[i];
  }
  return sum;
}

/**
 * A plain sine of `seconds` at `amplitude`, standing in for the original's render.
 * @param {number} seconds
 * @param {number} amplitude
 * @param {number} sampleRate
 */
function sine(seconds, amplitude, sampleRate) {
  return Float32Array.from({ length: Math.round(seconds * sampleRate) }, (_, i) => amplitude * Math.sin((2 * Math.PI * 220 * i) / sampleRate));
}

test("matchMixLoudness gives the bus gain that makes the live mix at the defaults as loud as the original", () => {
  const stems = renderPackStems("nes", BAND, SAMPLE_RATE);
  const original = sine(2.15, 0.9, SAMPLE_RATE);
  const { busScale, original: matchedOriginal } = matchMixLoudness(stems, original, SAMPLE_RATE);

  // The bus gets the stems times the default gains; times busScale it is matchLoudness's render.
  const live = busInput(stems, clampLevels(DEFAULT_LEVELS));
  const expected = matchLoudness(live, original, SAMPLE_RATE);
  let largest = 0;
  for (let i = 0; i < live.length; i++) largest = Math.max(largest, Math.abs(live[i] * busScale - expected.a[i]));
  assert.ok(largest < 1e-6, `largest difference ${largest}`);
  assert.deepEqual(matchedOriginal, expected.b, "the original is matched the same way");

  const scaledLive = live.map((sample) => sample * busScale);
  const levelDb = (/** @type {Float32Array} */ samples) => 20 * Math.log10(gatedRms(samples, SAMPLE_RATE));
  // Within 0.5 dB, not exactly: the gate of the level measure (-70 dBFS per 400 ms block) can drop
  // the ring-down of the console's filters after the last note once the mix is scaled down
  assert.ok(Math.abs(levelDb(scaledLive) - levelDb(matchedOriginal)) < 0.5, "both versions equally loud");
});

test("matchMixLoudness matches the mix at the levels it is given, and a silent mix leaves the bus at 1", () => {
  const stems = stemsOf({ P1: [0.5, -0.5, 0.5, -0.5], P2: [0, 0, 0, 0], TR: [0.1, 0.1, 0.1, 0.1], NO: [0, 0, 0, 0] });
  const original = Float32Array.of(0.2, -0.2, 0.2, -0.2);
  const onlyP1 = { ...UNITY, muted: { ...NOTHING_MUTED, TR: true } };

  // P1 alone has level 0.5, so the bus brings it to the -16 dBFS target: 0.1585 / 0.5.
  const { busScale } = matchMixLoudness(stems, original, 4, onlyP1);
  assert.equal(round4(busScale), round4(10 ** (-16 / 20) / 0.5));

  const silent = stemsOf({ P1: [0, 0], P2: [0, 0], TR: [0, 0], NO: [0, 0] });
  assert.equal(matchMixLoudness(silent, Float32Array.of(0.2, -0.2), 2).busScale, 1);
});

test("readLevels gives back what storeLevels kept, under one key and with a version", () => {
  const storage = fakeStorage();
  /** @type {Levels} */
  const levels = { P1: -2, P2: -4.5, TR: 3, NO: 6, muted: { ...NOTHING_MUTED, P2: true } };

  assert.equal(storeLevels(storage, levels), true);
  assert.deepEqual(readLevels(storage), levels);
  const stored = JSON.parse(storage.items.get(MIX_STORAGE_KEY));
  assert.equal(typeof stored.version, "number");
});

test("readLevels falls back to the defaults on a missing, unreadable or foreign value", () => {
  const defaults = clampLevels(DEFAULT_LEVELS);
  assert.deepEqual(readLevels(null), defaults, "no storage at all");
  assert.deepEqual(readLevels(fakeStorage()), defaults, "nothing stored yet");
  assert.deepEqual(readLevels(blockedStorage), defaults, "storage blocked");
  for (const value of ["not json", "[1, 2]", "null", '{"version": 999, "P1": 3}', '{"P1": 3}']) {
    const storage = fakeStorage();
    storage.setItem(MIX_STORAGE_KEY, value);
    assert.deepEqual(readLevels(storage), defaults, value);
  }
});

test("readLevels clamps stored levels, and storeLevels clamps what it keeps", () => {
  const storage = fakeStorage();
  storeLevels(storage, /** @type {any} */ ({ P1: 40, P2: -400, TR: 0, NO: 0, muted: {} }));
  const stored = JSON.parse(storage.items.get(MIX_STORAGE_KEY));
  assert.deepEqual([stored.packs.nes.P1, stored.packs.nes.P2], [12, -60]);

  stored.packs.nes.P1 = 99;
  storage.setItem(MIX_STORAGE_KEY, JSON.stringify(stored));
  assert.equal(readLevels(storage).P1, 12);
});

test("storeLevels reports false, without throwing, when there is no storage or it refuses", () => {
  assert.equal(storeLevels(null, DEFAULT_LEVELS), false);
  assert.equal(storeLevels(blockedStorage, DEFAULT_LEVELS), false);
});

test("every sound pack has default levels of its own, all inside the scale with room to boost", () => {
  assert.deepEqual(Object.keys(PACK_LEVELS).sort(), ["c64", "gameboy", "megadrive", "nes", "plain", "snes", "soft"]);
  assert.equal(defaultLevels("nes"), DEFAULT_LEVELS);
  assert.equal(defaultLevels("no such pack"), DEFAULT_LEVELS, "an unknown pack gets the NES levels");
  assert.equal(defaultLevels(), DEFAULT_LEVELS);
  for (const [pack, levels] of Object.entries(PACK_LEVELS)) {
    assert.ok(Object.isFrozen(levels) && Object.isFrozen(levels.muted), pack);
    for (const channel of CHANNELS) {
      assert.ok(levels[channel] >= MIN_DB && MAX_DB - levels[channel] >= 2, `${pack} ${channel} keeps 2 dB of room`);
    }
    assert.equal(levels.P1, 0, `${pack}: the melody stays at the pack's own balance`);
  }
  assert.ok(PACK_LEVELS.plain.NO < PACK_LEVELS.nes.NO, "the Plain pack's drums are lower than the chip's");
});

test("levels are kept per sound pack: changing one pack leaves the others as they were", () => {
  const storage = fakeStorage();
  const plain = { ...clampLevels(defaultLevels("plain")), NO: -3 };
  const nes = { ...clampLevels(DEFAULT_LEVELS), TR: 6 };
  assert.equal(storeLevels(storage, plain, "plain"), true);
  assert.equal(storeLevels(storage, nes, "nes"), true);
  assert.deepEqual(readLevels(storage, "plain"), plain);
  assert.deepEqual(readLevels(storage, "nes"), nes);
  assert.deepEqual(readLevels(storage, "gameboy"), clampLevels(defaultLevels("gameboy")), "an untouched pack has its defaults");
  assert.deepEqual(readLevels(storage), nes, "no pack named: the NES chip");
});

test("levels kept by the first version, which were one set for every pack, are ignored", () => {
  const storage = fakeStorage();
  storage.setItem(MIX_STORAGE_KEY, JSON.stringify({ version: 1, ...clampLevels(DEFAULT_LEVELS), NO: -20 }));
  assert.deepEqual(readLevels(storage, "plain"), clampLevels(defaultLevels("plain")));
});
