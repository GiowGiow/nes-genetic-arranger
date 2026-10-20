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
//   the channel is loud or soft. The scale ends at -60 dB, which counts as silence, and at
//   +12 dB, four times the amplitude, so every channel can still be boosted from its default.
// - The default levels are perceptual: the melody stays at the chip's balance, the harmony
//   1 dB under it, the bass 4 dB over it and the drums 10 dB over it. The chip's balance is
//   the NES's own mixer, but a listener on laptop speakers hears the bass and the drums as too
//   quiet. The triangle bass sits at 41 to 155 Hz, which small speakers barely reproduce and
//   the ear hears weakly, and the drums are short hits that measure 17 to 19 dB under the
//   melody. A loudness meter without a frequency weighting (gated RMS, `loudness.js`) cannot
//   see the first problem: it already puts the bass level with the melody. So the defaults are
//   chosen by ear, and `tests/mixer-defaults.test.js` measures the 8 examples to keep them in
//   bounds (research R1).
// - The page plays the stems through four Web Audio gains, so a change is heard at once, with
//   nothing rendered again. The bus adds the channels, and a limiter after it stops a boost on
//   every channel from clipping (`player.js`). The bus gain comes from `matchMixLoudness`: the
//   mix at the default levels is matched in loudness with the original once, so the visitor's
//   changes move away from a fair A/B.
// - The WAV download mixes the same stems here, offline (`mixStems`), and scales the result to
//   peak at -3 dBFS, the headroom of every render, so it needs no limiter.
//
// The levels are remembered in the browser's local storage when the browser allows it; a
// missing or unreadable value gives the defaults. The functions are pure: the storage is a
// parameter, so the tests pass a fake one.

import { scaleToPeak } from "./chip-synth.js";
import { matchLoudness } from "./loudness.js";

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
 * The highest level, in dB: four times the amplitude of the pack's own balance, so that even the
 * drums, at +10 dB by default, can go higher.
 * @example
 * dbToGain(MAX_DB); // ≈ 3.981
 */
export const MAX_DB = 12;

/**
 * The local-storage key of the levels.
 * @example
 * localStorage.getItem(MIX_STORAGE_KEY); // '{"version":1,"P1":0,...}'
 */
export const MIX_STORAGE_KEY = "nes-arranger-mix";

// The format of the stored levels; a value with another version is ignored.
const MIX_VERSION = 1;

/**
 * The default levels, chosen by ear on top of the chip's balance (research R1): the melody as
 * the chip has it, the harmony 1 dB under it, the bass 4 dB and the drums 10 dB over it. The
 * low triangle bass and the short drum hits sound much softer than the pulses on small
 * speakers, more than an unweighted loudness measure shows. `tests/mixer-defaults.test.js`
 * checks on the 8 examples that the bass then sits from 2 dB under to 7 dB over the melody, in
 * gated loudness, and that the drums come at least 8 dB closer to it.
 * @type {Readonly<Levels>}
 * @example
 * DEFAULT_LEVELS.TR; // 4: the bass, 4 dB over the chip's balance
 * DEFAULT_LEVELS.NO; // 10: the drums, about three times their chip amplitude
 */
export const DEFAULT_LEVELS = Object.freeze({
  P1: 0,
  P2: -1,
  TR: 4,
  NO: 10,
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
 * clampLevels({ P1: 20, P2: -100, muted: { NO: true } });
 * // { P1: 12, P2: -60, TR: DEFAULT_LEVELS.TR, NO: DEFAULT_LEVELS.NO,
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
  return scaleToPeak(sumStems(stems, channelGains(levels, options.muted ?? levels.muted)));
}

/**
 * Match the live mix with the original in loudness, once per render (research R2).
 *
 * The player adds the stems, each times its channel gain, on an arrangement bus. This finds the
 * bus gain that brings that sum, at the given levels, to the loudness of the original
 * (`matchLoudness`), and returns the original matched the same way. The levels are the
 * defaults, so a fresh mix and the original sound equally loud, and the visitor's changes are
 * relative to a fair A/B.
 * @param {Record<ChannelName, ArrayLike<number>>} stems four stems of one length (`renderPackStems`)
 * @param {Float32Array} original the original's render, on the same timeline
 * @param {number} sampleRate samples per second of both
 * @param {Omit<Levels, "muted"> & {muted?: Partial<Record<ChannelName, boolean>>}} [levels] the
 *   levels of the mix to match (default DEFAULT_LEVELS)
 * @returns {{busScale: number, original: Float32Array}} the bus gain (1 when the mix is silent,
 *   since there is nothing to match) and the original, matched
 * @example
 * const { busScale, original } = matchMixLoudness(stems, originalRaw, 44100);
 * player.load({ arrangement: stems, original }, 44100, { busScale });
 */
export function matchMixLoudness(stems, original, sampleRate, levels = DEFAULT_LEVELS) {
  const mix = Float32Array.from(sumStems(stems, channelGains(levels)));
  const matched = matchLoudness(mix, original, sampleRate);
  const mixPeak = peakOf(mix);
  return { busScale: mixPeak > 0 ? peakOf(matched.a) / mixPeak : 1, original: matched.b };
}

/**
 * @param {Record<ChannelName, ArrayLike<number>>} stems
 * @param {Record<ChannelName, number>} gains
 * @returns {Float64Array} each stem times its gain, added
 */
function sumStems(stems, gains) {
  const { P1, P2, TR, NO } = stems;
  const mix = new Float64Array(P1.length);
  for (let i = 0; i < mix.length; i++) {
    mix[i] = gains.P1 * P1[i] + gains.P2 * P2[i] + gains.TR * TR[i] + gains.NO * NO[i];
  }
  return mix;
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
