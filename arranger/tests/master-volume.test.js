// @ts-check
// Tests for the master volume in audio/mixer.js: one listening control over the whole playback,
// arrangement and original alike (spec 005). It is a percentage from 0 to 100 that becomes a
// gain with a square-law taper, it is remembered in local storage under its own key, and a
// missing, blocked or unreadable storage gives the default of 80 %.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_VOLUME,
  VOLUME_STORAGE_KEY,
  clampVolume,
  readVolume,
  storeVolume,
  volumeToGain,
} from "../src/audio/mixer.js";

/** A storage that keeps strings, like localStorage. */
function fakeStorage() {
  /** @type {Map<string, string>} */
  const items = new Map();
  return {
    items,
    getItem: (/** @type {string} */ key) => items.get(key) ?? null,
    setItem: (/** @type {string} */ key, /** @type {string} */ value) => void items.set(key, value),
  };
}

const blockedStorage = {
  getItem() {
    throw new Error("SecurityError");
  },
  setItem() {
    throw new Error("QuotaExceededError");
  },
};

test("the volume starts at 80 percent and is kept under the key nes-arranger-volume", () => {
  assert.equal(DEFAULT_VOLUME, 80);
  assert.equal(VOLUME_STORAGE_KEY, "nes-arranger-volume");
});

test("a volume percentage becomes a gain with a square-law taper: 0 is silence, 100 is the mix as it is", () => {
  assert.equal(volumeToGain(0), 0);
  assert.equal(volumeToGain(100), 1);
  assert.ok(Math.abs(volumeToGain(50) - 0.25) < 1e-12, "half the slider is a quarter of the amplitude, -12 dB");
  assert.ok(Math.abs(volumeToGain(80) - 0.64) < 1e-12);
  assert.ok(volumeToGain(30) < volumeToGain(31), "louder as the slider rises");
});

test("a volume past the slider, or not a number, is brought inside 0 to 100", () => {
  assert.equal(clampVolume(140), 100);
  assert.equal(clampVolume(-5), 0);
  assert.equal(clampVolume(Number.NaN), DEFAULT_VOLUME);
  assert.equal(clampVolume(/** @type {any} */ ("loud")), DEFAULT_VOLUME);
  assert.equal(volumeToGain(250), 1, "never a boost past the mix: the original has no limiter");
});

test("readVolume gives back what storeVolume kept", () => {
  const storage = fakeStorage();
  assert.equal(storeVolume(storage, 35), true);
  assert.equal(storage.items.get(VOLUME_STORAGE_KEY), "35");
  assert.equal(readVolume(storage), 35);
  storeVolume(storage, 0);
  assert.equal(readVolume(storage), 0, "silence is a volume too, not a missing value");
});

test("readVolume falls back to 80 on no storage, a blocked one, nothing stored or garbage", () => {
  assert.equal(readVolume(null), DEFAULT_VOLUME);
  assert.equal(readVolume(blockedStorage), DEFAULT_VOLUME);
  assert.equal(readVolume(fakeStorage()), DEFAULT_VOLUME);
  for (const value of ["", "loud", "NaN", "{}", "null"]) {
    const storage = fakeStorage();
    storage.setItem(VOLUME_STORAGE_KEY, value);
    assert.equal(readVolume(storage), DEFAULT_VOLUME, JSON.stringify(value));
  }
  const storage = fakeStorage();
  storage.setItem(VOLUME_STORAGE_KEY, "400");
  assert.equal(readVolume(storage), 100, "a stored value past the slider is clamped");
});

test("storeVolume clamps what it keeps and reports false, without throwing, when it cannot keep it", () => {
  const storage = fakeStorage();
  storeVolume(storage, 400);
  assert.equal(storage.items.get(VOLUME_STORAGE_KEY), "100");
  assert.equal(storeVolume(null, 50), false);
  assert.equal(storeVolume(blockedStorage, 50), false);
});
