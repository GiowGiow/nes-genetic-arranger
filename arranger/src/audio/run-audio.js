// @ts-check
// The sound of a run, rendered on demand.
//
// A run of the genetic algorithm ends in an arrangement: a few thousand notes. Its sound is far
// bigger: four stems, one per channel, plus the original's render, each one 32-bit float per
// sample. A three-minute song at 44.1 kHz makes each of them 32 MB, so one run's audio is well
// over 100 MB, and a visit of five runs would hold half a gigabyte for sounds nobody is
// listening to. So a run keeps the notes (`arrangement`, `voices`), which are cheap and enough
// to make the sound again, and holds its audio only while it is the run on screen
// (`releaseAudio` in `ui/run-list.js` frees the others). Bringing a run back renders it again,
// which takes a second or less, and is deterministic: the same notes give the same samples.
//
// This module is the "render again" half: pure functions of the notes, the sound pack and the
// sample rate, with no browser API.

import { renderVoices } from "./plain-synth.js";
import { defaultLevels, matchMixLoudness } from "./mixer.js";
import { renderPackStems } from "./sound-packs.js";

/**
 * What a run needs to make its sound, always kept.
 * @typedef {object} RunSource
 * @property {any} arrangement the realized arrangement (`assemble`)
 * @property {import("./plain-synth.js").Voices} voices the original's notes, in beats
 * @property {number} tempoBpm the tempo the original plays at
 * @property {number} durationBeats the length of the render, in beats
 */

/**
 * The big buffers of a run, kept only while it is on screen.
 * @typedef {object} RunAudio
 * @property {string} pack the sound pack the stems were rendered with
 * @property {number} sampleRate samples per second of every buffer
 * @property {Record<import("./chip-synth.js").ChannelName, Float32Array>} stems the arrangement's four channels
 * @property {number} busScale the bus gain that matches the live mix with the original in loudness
 * @property {Float32Array} originalRaw the original's plain render, before its loudness is matched
 * @property {Float32Array} originalSamples the original, matched to the mix
 */

/**
 * Render a run's sound for a sound pack, reusing what an earlier render already holds.
 *
 * The same pack and rate give the earlier audio back untouched. Another pack renders the stems
 * again and matches the original to them again, but keeps the original's plain render, which does
 * not depend on the pack. Another sample rate (a different sound card) renders everything again.
 *
 * @param {RunSource} run
 * @param {string} soundPack a sound pack id (`SOUND_PACKS` in `sound-packs.js`), for example "nes" or "snes"
 * @param {number} sampleRate samples per second
 * @param {RunAudio | null} [kept] the run's audio from an earlier render, if it still has it
 * @returns {RunAudio} a new object, or `kept` itself when it already fits
 * @example
 * run.audio = renderRunAudio(run, "nes", context.sampleRate, run.audio);
 * player.load({ arrangement: run.audio.stems, original: run.audio.originalSamples }, run.audio.sampleRate, { busScale: run.audio.busScale });
 */
export function renderRunAudio(run, soundPack, sampleRate, kept = null) {
  if (kept && kept.pack === soundPack && kept.sampleRate === sampleRate) return kept;
  const originalRaw =
    kept && kept.sampleRate === sampleRate
      ? kept.originalRaw
      : renderVoices(run.voices, run.tempoBpm, sampleRate, run.durationBeats);
  const stems = renderPackStems(soundPack, run.arrangement, sampleRate);
  const matched = matchMixLoudness(stems, originalRaw, sampleRate, defaultLevels(soundPack));
  return {
    pack: soundPack,
    sampleRate,
    stems,
    busScale: matched.busScale,
    originalRaw,
    originalSamples: matched.original,
  };
}
