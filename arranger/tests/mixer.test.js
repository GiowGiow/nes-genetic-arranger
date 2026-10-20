// @ts-check
// Tests for audio/mixer.js: the visitor's four channel levels, in dB, turned into gains on the
// stems (spec 005, story 1, research R1 to R3).
//
// They read as the rules of the mixer: a level is in dB from -60 (silence) to +6; mute silences a
// channel at any level; the offline mix (for the WAV download) is the stems times their gains,
// scaled to peak at -3 dBFS; and the levels survive a reload through a storage that may be
// missing, full or hold anything at all.

import { test } from "node:test";
import assert from "node:assert/strict";

import { PEAK_LEVEL } from "../src/audio/chip-synth.js";
import {
  CHANNELS,
  DEFAULT_LEVELS,
  MAX_DB,
  MIN_DB,
  MIX_STORAGE_KEY,
  channelGains,
  clampLevels,
  dbToGain,
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

test("the mixer has the four channels P1, P2, TR and NO, each from -60 dB to +6 dB", () => {
  assert.deepEqual(CHANNELS, ["P1", "P2", "TR", "NO"]);
  assert.equal(MIN_DB, -60);
  assert.equal(MAX_DB, 6);
  assert.equal(MIX_STORAGE_KEY, "nes-arranger-mix");
});

test("a level in dB becomes a gain: 0 dB keeps the stem, -6 dB halves it, +6 dB doubles it", () => {
  assert.equal(dbToGain(0), 1);
  assert.equal(round4(dbToGain(-6)), 0.5012);
  assert.equal(round4(dbToGain(6)), 1.9953);
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

test("the default levels stay inside the range and mute nothing (their values come from mixer-defaults)", () => {
  for (const channel of CHANNELS) {
    assert.ok(DEFAULT_LEVELS[channel] >= MIN_DB && DEFAULT_LEVELS[channel] <= MAX_DB, channel);
    assert.equal(DEFAULT_LEVELS.muted[channel], false, channel);
  }
  assert.ok(Object.isFrozen(DEFAULT_LEVELS) && Object.isFrozen(DEFAULT_LEVELS.muted));
});

test("clampLevels keeps every level inside [-60, +6] and fills a missing or unreadable one with its default", () => {
  const input = { P1: 12, P2: -100, TR: "loud", muted: { NO: true, P1: "yes" } };
  const clamped = clampLevels(/** @type {any} */ (input));

  assert.deepEqual(clamped, {
    P1: 6,
    P2: -60,
    TR: DEFAULT_LEVELS.TR,
    NO: DEFAULT_LEVELS.NO,
    muted: { P1: false, P2: false, TR: false, NO: true },
  });
  assert.deepEqual(input, { P1: 12, P2: -100, TR: "loud", muted: { NO: true, P1: "yes" } }, "the input is unchanged");
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
  for (const packId of ["nes", "gameboy", "plain"]) {
    const expected = renderPack(packId, BAND, 22050);
    const mixed = mixStems(renderPackStems(packId, BAND, 22050), UNITY);
    let largest = 0;
    for (let i = 0; i < expected.length; i++) largest = Math.max(largest, Math.abs(mixed[i] - expected[i]));
    assert.ok(largest < 1e-5, `${packId}: largest difference ${largest}`);
  }
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
  assert.deepEqual([stored.P1, stored.P2], [6, -60]);

  storage.setItem(MIX_STORAGE_KEY, JSON.stringify({ ...stored, P1: 99 }));
  assert.equal(readLevels(storage).P1, 6);
});

test("storeLevels reports false, without throwing, when there is no storage or it refuses", () => {
  assert.equal(storeLevels(null, DEFAULT_LEVELS), false);
  assert.equal(storeLevels(blockedStorage, DEFAULT_LEVELS), false);
});
