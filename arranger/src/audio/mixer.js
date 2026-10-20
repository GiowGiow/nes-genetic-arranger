// @ts-check
// The channel mixer: one volume control per channel of the arrangement (spec 005, research R1
// to R3).
//
// A sound pack renders the arrangement as four stems, one per channel: P1 (melody), P2
// (harmony), TR (bass) and NO (drums). Added together they make the pack's render
// (`renderPackStems` in `sound-packs.js`). Mixing is then only a matter of gains, applied in
// stages, a chain called gain staging:
//
//   stems -> one gain per channel -> arrangement bus -> limiter -> speakers
//
// - Each channel's level is in decibels (dB), relative to the pack's own balance. 0 dB leaves
//   the stem as the pack made it (for the NES chip, with the chip's own mixer gains, so the
//   offsets sit on top of `CHANNEL_GAINS`). -6 dB halves the amplitude, and +6 dB doubles it.
//   The ear hears loudness as ratios, so each 6 dB step sounds like the same change, whether
//   the channel is loud or soft. The scale ends at -60 dB, which counts as silence, and at +6 dB.
// - The default levels are measured on the 8 examples (research R1,
//   `tests/mixer-defaults.test.js`): P2 sits 1 dB under P1, and TR and NO 3 dB under it, in
//   gated loudness (`loudness.js`). With the chip's gains alone the short drum hits measure
//   about 18 dB under the melody, so the drums get the largest lift. Only the differences
//   between channels matter, so the defaults are moved down together until the loudest one,
//   the drums, sits at MAX_DB.
// - The page plays the stems through four Web Audio gains, so a change is heard at once, with
//   nothing rendered again. The bus adds the channels, and a limiter after it stops a +6 dB boost
//   on every channel from clipping (`player.js`).
// - The WAV download mixes the same stems here, offline (`mixStems`), and scales the result to
//   peak at -3 dBFS, the headroom of every render, so it needs no limiter.
//
// The levels are remembered in the browser's local storage when the browser allows it; a
// missing or unreadable value gives the defaults. The functions are pure: the storage is a
// parameter, so the tests pass a fake one.

import { scaleToPeak } from "./chip-synth.js";

/** @typedef {import("./chip-synth.js").ChannelName} ChannelName */

/**
 * The visitor's mix: a level in dB per channel, relative to the pack's own balance, and a mute
 * flag per channel.
 * @typedef {object} Levels
 * @property {number} P1 the melody, in dB from MIN_DB (silence) to MAX_DB
 * @property {number} P2 the harmony
 * @property {number} TR the bass
 * @property {number} NO the drums
 * @property {Record<ChannelName, boolean>} muted true for a silenced channel
 */

/**
 * Where the levels are kept: the browser's `localStorage`, or a fake one in the tests.
 * @typedef {{getItem(key: string): string | null, setItem(key: string, value: string): void}} LevelStorage
 */

/**
 * The channels, in the order the mixer shows them.
 * @type {readonly ChannelName[]}
 * @example
 * CHANNELS; // ["P1", "P2", "TR", "NO"]
 */
export const CHANNELS = Object.freeze(/** @type {ChannelName[]} */ (["P1", "P2", "TR", "NO"]));

/**
 * The lowest level, in dB: a channel at this level or below is silent.
 * @example
 * dbToGain(MIN_DB); // 0
 */
export const MIN_DB = -60;

/**
 * The highest level, in dB: twice the amplitude of the pack's own balance.
 * @example
 * dbToGain(MAX_DB); // ≈ 1.995
 */
export const MAX_DB = 6;

/**
 * The local-storage key of the levels.
 * @example
 * localStorage.getItem(MIX_STORAGE_KEY); // '{"version":1,"P1":0,...}'
 */
export const MIX_STORAGE_KEY = "nes-arranger-mix";

// The format of the stored levels; a value with another version is ignored.
const MIX_VERSION = 1;

/**
 * The default levels, measured on the 8 examples (research R1, `tests/mixer-defaults.test.js`):
 * relative to the chip's balance, the drums go up 15 dB and the bass down 4 dB against the
 * melody, then all four move down 9 dB so that the drums stay within MAX_DB.
 * @type {Readonly<Levels>}
 * @example
 * DEFAULT_LEVELS.NO - DEFAULT_LEVELS.P1; // 15: the drums, 15 dB over the melody's level
 */
export const DEFAULT_LEVELS = Object.freeze({
  P1: -9,
  P2: -5.5,
  TR: -13,
  NO: 6,
  muted: Object.freeze({ P1: false, P2: false, TR: false, NO: false }),
});

/**
 * Turn a level in dB into an amplitude gain: 10^(dB / 20), and 0 at MIN_DB or below.
 * @param {number} db
 * @returns {number} the factor that multiplies the stem's samples
 * @example
 * dbToGain(0); // 1
 * dbToGain(-6); // ≈ 0.501, half the amplitude
 * dbToGain(-60); // 0, silence
 */
export function dbToGain(db) {
  return db <= MIN_DB ? 0 : 10 ** (db / 20);
}

/**
 * The gain of every channel: its level as a gain, or 0 when it is muted.
 * @param {Omit<Levels, "muted"> & {muted?: Partial<Record<ChannelName, boolean>>}} levels
 * @param {Partial<Record<ChannelName, boolean>>} [muted] the channels to silence (default `levels.muted`)
 * @returns {Record<ChannelName, number>}
 * @example
 * channelGains({ P1: 0, P2: -6, TR: 6, NO: 0, muted: { NO: true } });
 * // { P1: 1, P2: ≈ 0.501, TR: ≈ 1.995, NO: 0 }
 */
export function channelGains(levels, muted = levels.muted) {
  const gainOf = (/** @type {ChannelName} */ channel) => (muted?.[channel] ? 0 : dbToGain(levels[channel]));
  return { P1: gainOf("P1"), P2: gainOf("P2"), TR: gainOf("TR"), NO: gainOf("NO") };
}

/**
 * Levels made safe: every level inside [MIN_DB, MAX_DB], a missing or unreadable level replaced
 * by its default, and a mute flag that is exactly true or false.
 * @param {Partial<Levels> | null | undefined} levels anything, for example parsed from storage
 * @returns {Levels} a new object; the input is not changed
 * @example
 * clampLevels({ P1: 12, P2: -100, muted: { NO: true } });
 * // { P1: 6, P2: -60, TR: DEFAULT_LEVELS.TR, NO: DEFAULT_LEVELS.NO,
 * //   muted: { P1: false, P2: false, TR: false, NO: true } }
 */
export function clampLevels(levels) {
  const levelOf = (/** @type {ChannelName} */ channel) => {
    const db = levels?.[channel];
    if (typeof db !== "number" || Number.isNaN(db)) return DEFAULT_LEVELS[channel];
    return Math.min(MAX_DB, Math.max(MIN_DB, db));
  };
  const mutedOf = (/** @type {ChannelName} */ channel) => levels?.muted?.[channel] === true;
  return {
    P1: levelOf("P1"),
    P2: levelOf("P2"),
    TR: levelOf("TR"),
    NO: levelOf("NO"),
    muted: { P1: mutedOf("P1"), P2: mutedOf("P2"), TR: mutedOf("TR"), NO: mutedOf("NO") },
  };
}

/**
 * Mix the stems offline with the given levels, as the WAV download needs: each stem times its
 * gain, added, and scaled to peak at -3 dBFS. When every channel is silent, the mix is zeros.
 * @param {Record<ChannelName, ArrayLike<number>>} stems four stems of one length (`renderPackStems`)
 * @param {Omit<Levels, "muted"> & {muted?: Partial<Record<ChannelName, boolean>>}} levels the level of each channel, in dB
 * @param {{muted?: Partial<Record<ChannelName, boolean>>}} [options] the channels to silence
 *   (default `levels.muted`)
 * @returns {Float32Array} the mix, as long as the stems
 * @example
 * const stems = { P1: [0.5, -0.5], P2: [0.25, 0.25], TR: [0, 0], NO: [0, 0] };
 * mixStems(stems, { P1: 0, P2: -6.02, TR: 0, NO: 0 }); // [0.7079, -0.4248]: [0.625, -0.375] scaled
 */
export function mixStems(stems, levels, options = {}) {
  const gains = channelGains(levels, options.muted ?? levels.muted);
  const { P1, P2, TR, NO } = stems;
  const mix = new Float64Array(P1.length);
  for (let i = 0; i < mix.length; i++) {
    mix[i] = gains.P1 * P1[i] + gains.P2 * P2[i] + gains.TR * TR[i] + gains.NO * NO[i];
  }
  return scaleToPeak(mix);
}

/**
 * The levels kept by `storeLevels`, or the defaults when there are none, the storage is blocked,
 * or the value is unreadable or from another version.
 * @param {LevelStorage | null | undefined} storage usually `localStorage`
 * @returns {Levels} clamped levels, a new object
 * @example
 * readLevels(localStorage); // the visitor's last levels, or a copy of DEFAULT_LEVELS
 */
export function readLevels(storage) {
  try {
    const stored = JSON.parse(storage?.getItem(MIX_STORAGE_KEY) ?? "null");
    if (stored?.version === MIX_VERSION) return clampLevels(stored);
  } catch {
    // A blocked storage or a value that is not JSON: the defaults below.
  }
  return clampLevels(DEFAULT_LEVELS);
}

/**
 * Keep the levels, clamped and with a version, for the next visit.
 * @param {LevelStorage | null | undefined} storage usually `localStorage`
 * @param {Levels} levels
 * @returns {boolean} false when there is no storage or it refuses (blocked, full); never throws
 * @example
 * storeLevels(localStorage, { ...DEFAULT_LEVELS, NO: -6 }); // true
 */
export function storeLevels(storage, levels) {
  if (!storage) return false;
  try {
    storage.setItem(MIX_STORAGE_KEY, JSON.stringify({ version: MIX_VERSION, ...clampLevels(levels) }));
    return true;
  } catch {
    return false;
  }
}
