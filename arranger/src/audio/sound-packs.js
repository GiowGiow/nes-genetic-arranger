// @ts-check
// Sound packs: the same arrangement played with the sound of other chips (spec 004).
//
// The arrangement is written for the NES, but its four lines (melody, harmony, bass, drums) can be
// voiced by other machines, the way a cover changes instruments. Each pack keeps the notes and
// the timeline of the NES render (`renderLength`), so the player switches packs at the same
// second, and changes only how each note sounds:
//
// - NES chip: the chip synthesizer of `chip-synth.js`, softened. The raw chip is thin and
//   bright: a 12.5% pulse on P2 is nasal, and the unfiltered square edges are a burst of
//   harmonics up to the Nyquist frequency, which sounds shrill on headphones. The pack keeps
//   everything that makes it a NES (the 4-bit volumes, the stepped triangle, the noise
//   register) and changes three things:
//   * P2 plays a 50% pulse instead of 12.5%. It stays apart from P1's 25%, and a 50% pulse has
//     only odd partials, the roundest of the chip's four widths. It is 4 dB under the chip's
//     balance, since the wider pulse carries more energy.
//   * The sound goes through the console's own output filters: a first-order high-pass at
//     90 Hz (which also blocks any offset) and a first-order low-pass at 14 kHz. The console's
//     second high-pass, at 440 Hz, is left out: emulators apply it, but it would take most of
//     the arrangement's bass (41 to 155 Hz) away.
//   * A gentle second-order low-pass at 4 kHz stands for the small speaker of a CRT television,
//     the machine this sound was made for. It is the part that matters most: pulse partials
//     fall only 6 dB per octave whatever the width, so the width alone does not tame them
//     (measured on the examples with A-weighting, a 6 kHz cutoff lowers the share of the sound
//     above 2 kHz, where the ear is most sensitive, by 1 dB, and 4 kHz by 2.4 dB).
//   The filters work on each stem alone, which gives the same mix as filtering the mix; the
//   bass and the drums are lifted by 2 to 3 dB to make up for what the filters took.
// - NES chip (raw): the chip synthesizer exactly as the command line renders it (`renderChip`),
//   for hearing what the softening changed. It sits last in the list.
// - Mega Drive: the Yamaha YM2612 FM chip and the SN76489 noise chip of the Sega Genesis,
//   in `megadrive-pack.js`: a brass lead, an electric piano, a slap bass, FM and noise drums.
// - Super Nintendo: the Sony S-DSP, in `snes-pack.js`: samples made in code and played through
//   the chip's pitch, ADSR, Gaussian interpolation and echo (`snes-dsp.js`).
// - Game Boy: the DMG chip has two pulse channels (here 50% and 25% duty, rounder than the NES's
//   25% and 12.5%), a wave channel that plays a 32-step table of 4-bit samples (here a sine,
//   so the bass is softer than the NES triangle) and a noise channel built on a shift register
//   whose short mode sounds metallic. Notes fall off quickly, like its volume envelopes.
// - Commodore 64: the SID chip offers sawtooth and pulse waves with ADSR envelopes (attack,
//   decay, sustain, release) and an analog filter. Here the melody is a sawtooth, the harmony a
//   wide pulse, the bass a smooth triangle, and a low-pass filter on the mix makes it warm.
// - Soft synth: sines and triangles with slow attacks and releases, and drums made of a falling
//   sine (kick) and filtered noise, to hear the harmony without any chip buzz.
// - Plain: the timbre of the original's player (`plain-synth.js`), so A/B compares the content
//   of the two versions with the same instruments.
//
// These are impressions of each chip, not cycle-exact emulations.
// Every pack is a pure, deterministic function: noise comes from fixed shift registers or from
// `random.js` with a fixed seed, and the mix peaks at -3 dBFS like the NES render (the page then
// matches its loudness with the original's).
//
// Every pack can also keep its four lines apart, as stems: P1 (melody), P2 (harmony), TR (bass)
// and NO (drums), so the page can set each line's level while it plays (spec 005,
// `audio/mixer.js`). The stems share one scale: added together they give the pack's render. The
// plain pack maps its voices the same way: the melody to P1, the two other voices to P2 and TR,
// and the drum hits to NO.

import {
  CHANNEL_GAINS,
  PEAK_LEVEL,
  SAMPLE_RATE,
  noiseWave,
  renderChip,
  renderChipStems,
  renderLength,
  scaleToPeak,
} from "./chip-synth.js";
import { biquadLowpass, highpass, lowpass } from "./filters.js";
import { noteFrequency, sounding } from "./note-schedule.js";
import { renderMegaDriveStems } from "./megadrive-pack.js";
import { mixVoices, renderVoices } from "./plain-synth.js";
import { renderSnesStems } from "./snes-pack.js";
import { createRandom } from "../core/random.js";

/** @typedef {import("./chip-synth.js").ChannelName} ChannelName */

/**
 * One track per channel of the arrangement, all of the same length and on one scale.
 * @typedef {Record<ChannelName, Float32Array>} Stems
 */

/**
 * One sound pack, as the page lists it.
 * @typedef {object} SoundPack
 * @property {string} id "nes", "megadrive", "snes", "gameboy", "c64", "soft", "plain" or "nes-raw"
 * @property {string} name the name shown on the page
 * @property {string} description one line on how it sounds
 */

/**
 * The packs, in the order the page offers them; the NES chip comes first.
 * @type {readonly SoundPack[]}
 * @example
 * SOUND_PACKS.map((pack) => pack.id);
 * // ["nes", "megadrive", "snes", "gameboy", "c64", "soft", "plain", "nes-raw"]
 */
export const SOUND_PACKS = Object.freeze([
  Object.freeze({
    id: "nes",
    name: "NES chip",
    description: "The NES 2A03, softened: pulse waves with a rounder harmony, a stepped triangle bass and noise drums, through a small TV speaker's filter.",
  }),
  Object.freeze({
    id: "megadrive",
    name: "Mega Drive",
    description: "The Sega Genesis: warm FM synthesis from the YM2612, a brass lead, an electric piano, a slap bass and noise drums.",
  }),
  Object.freeze({
    id: "snes",
    name: "Super Nintendo",
    description: "The SNES sound chip: soft sampled-style voices through its Gaussian filter, with a flute lead, a harp, a round bass and a dreamy echo.",
  }),
  Object.freeze({
    id: "gameboy",
    name: "Game Boy",
    description: "The Game Boy's DMG chip: rounder pulses, a 4-bit wave-table bass and short metallic noise.",
  }),
  Object.freeze({
    id: "c64",
    name: "Commodore 64",
    description: "The SID chip: a sawtooth melody, a wide pulse harmony and a triangle bass, warmed by a low-pass filter.",
  }),
  Object.freeze({
    id: "soft",
    name: "Soft synth",
    description: "Sines and triangles with gentle attacks, and soft drums: the harmony without any chip buzz.",
  }),
  Object.freeze({
    id: "plain",
    name: "Plain",
    description: "The same plain instruments as the original's player, to compare the content of the two versions.",
  }),
  Object.freeze({
    id: "nes-raw",
    name: "NES chip (raw)",
    description: "The NES 2A03 exactly as the command line renders it: thin, bright pulses and an unfiltered square edge.",
  }),
]);

/**
 * Waveforms as functions of the phase, the position inside one period, in [0, 1).
 * @example
 * WAVES.pulse(0.1, 0.25); // 1: inside the high part of a 25% pulse
 * WAVES.sawtooth(0.75); // 0.5
 */
export const WAVES = Object.freeze({
  /**
   * @param {number} phase
   * @param {number} duty share of the period spent high
   */
  pulse: (phase, duty) => (phase < duty ? 1 : -1),
  /** @param {number} phase */
  sawtooth: (phase) => 2 * phase - 1,
  /** @param {number} phase */
  triangle: (phase) => (phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase),
  /** @param {number} phase */
  sine: (phase) => Math.sin(2 * Math.PI * phase),
  /**
   * The Game Boy wave channel: a 32-step table of 4-bit samples (0 to 15), here one sine
   * period, centred on 0.
   * @param {number} phase
   */
  gameboyWave: (phase) => (GAMEBOY_WAVE_TABLE[Math.floor(phase * 32) % 32] - 7.5) / 7.5,
});

// One sine period quantized to 32 steps of 16 levels, as a Game Boy wave RAM would hold it.
const GAMEBOY_WAVE_TABLE = Object.freeze(
  Array.from({ length: 32 }, (_, step) => Math.round(7.5 + 7.5 * Math.sin((2 * Math.PI * step) / 32))),
);

/**
 * How a pitched channel sounds in a pack.
 * @typedef {object} VoiceSound
 * @property {(phase: number) => number} wave the waveform
 * @property {number} attack seconds to reach full level
 * @property {number} decay seconds to fall from full level to the sustain level
 * @property {number} sustain level held after the decay, 0 to 1
 * @property {number} release seconds of fade at the end of the note (inside the note)
 * @property {number} gain the channel's level in the mix
 * @property {number} [volumeSteps] when set, the loudness is rounded to this many steps, as a
 *   chip's 4-bit volume does
 */

/**
 * How a drum note sounds in a pack: noise from a shift register or from random numbers, or a
 * falling tone (a synthesized kick drum).
 * @typedef {{kind: "lfsr", period: number, shortMode: boolean, decay: number, gain: number}
 *   | {kind: "white", lowpassHz: number, decay: number, gain: number}
 *   | {kind: "sweep", fromHz: number, toHz: number, decay: number, gain: number}} DrumSound
 */

/**
 * A pack drawn with the oscillator synthesizer.
 * @typedef {object} OscillatorPack
 * @property {{P1: VoiceSound, P2: VoiceSound, TR: VoiceSound}} voices
 * @property {Record<number, DrumSound>} drums by General MIDI drum note (36 kick, 38 snare, 42 hi-hat)
 * @property {number | null} lowpassHz cutoff of a one-pole low-pass filter on the mix, or none
 */

/** @type {Record<string, OscillatorPack>} */
const OSCILLATOR_PACKS = {
  gameboy: {
    voices: {
      P1: { wave: (phase) => WAVES.pulse(phase, 0.5), attack: 0.002, decay: 0.35, sustain: 0.55, release: 0.01, gain: 0.9, volumeSteps: 15 },
      P2: { wave: (phase) => WAVES.pulse(phase, 0.25), attack: 0.002, decay: 0.25, sustain: 0.45, release: 0.01, gain: 0.7, volumeSteps: 15 },
      TR: { wave: WAVES.gameboyWave, attack: 0.002, decay: 0, sustain: 1, release: 0.01, gain: 1.0 },
    },
    drums: {
      36: { kind: "lfsr", period: 1016, shortMode: false, decay: 0.12, gain: 0.9 },
      38: { kind: "lfsr", period: 128, shortMode: false, decay: 0.14, gain: 0.7 },
      42: { kind: "lfsr", period: 16, shortMode: true, decay: 0.04, gain: 0.35 },
    },
    lowpassHz: null,
  },
  c64: {
    voices: {
      P1: { wave: WAVES.sawtooth, attack: 0.004, decay: 0.3, sustain: 0.7, release: 0.04, gain: 0.8 },
      P2: { wave: (phase) => WAVES.pulse(phase, 0.4), attack: 0.01, decay: 0.4, sustain: 0.6, release: 0.05, gain: 0.6 },
      TR: { wave: WAVES.triangle, attack: 0.003, decay: 0.2, sustain: 0.85, release: 0.03, gain: 1.0 },
    },
    drums: {
      36: { kind: "sweep", fromHz: 160, toHz: 50, decay: 0.15, gain: 1.0 },
      38: { kind: "white", lowpassHz: 6000, decay: 0.15, gain: 0.6 },
      42: { kind: "white", lowpassHz: 12000, decay: 0.05, gain: 0.3 },
    },
    lowpassHz: 4000,
  },
  soft: {
    voices: {
      P1: { wave: WAVES.sine, attack: 0.015, decay: 0.4, sustain: 0.8, release: 0.08, gain: 0.9 },
      P2: { wave: WAVES.triangle, attack: 0.03, decay: 0.5, sustain: 0.6, release: 0.1, gain: 0.45 },
      TR: { wave: WAVES.sine, attack: 0.01, decay: 0.3, sustain: 0.8, release: 0.06, gain: 1.0 },
    },
    drums: {
      36: { kind: "sweep", fromHz: 110, toHz: 45, decay: 0.2, gain: 0.9 },
      38: { kind: "white", lowpassHz: 2500, decay: 0.12, gain: 0.35 },
      42: { kind: "white", lowpassHz: 8000, decay: 0.035, gain: 0.12 },
    },
    lowpassHz: 7000,
  },
};

// The noise generators' seed: any fixed number keeps every render identical.
const NOISE_SEED = 2026;

/** @type {readonly ChannelName[]} */
const CHANNELS = Object.freeze(["P1", "P2", "TR", "NO"]);

// The packs that are built as stems first, and whose render is the stems added together.
const STEM_PACKS = new Set(["nes", "megadrive", "snes"]);

// Stems whose channel gains are already inside them (every pack but the NES chip).
const UNIT_GAINS = Object.freeze({ P1: 1, P2: 1, TR: 1, NO: 1 });

/**
 * Render an arrangement with a sound pack.
 *
 * @param {string} packId one of the ids of SOUND_PACKS
 * @param {import("./chip-synth.js").ChipArrangement} arrangement the tempo and the channels' notes, in beats
 * @param {number} [sampleRate] samples per second (default 44,100)
 * @returns {Float32Array} `renderLength(arrangement, sampleRate)` samples, peaking at -3 dBFS
 * @throws {Error} for an unknown pack
 * @example
 * renderPack("gameboy", arrangement, 44100).length === renderLength(arrangement, 44100); // true
 * renderPack("nes-raw", arrangement); // the same samples as renderChip(arrangement)
 */
export function renderPack(packId, arrangement, sampleRate = SAMPLE_RATE) {
  if (packId === "nes-raw") return renderChip(arrangement, sampleRate);
  if (STEM_PACKS.has(packId)) return sumOfStems(renderPackStems(packId, arrangement, sampleRate));
  const length = renderLength(arrangement, sampleRate);
  if (packId === "plain") return renderPlain(arrangement, sampleRate, length);
  // All four channels write into one mix, the same sums in the same order as before stems.
  const mix = new Float64Array(length);
  renderOscillators(oscillatorPack(packId), arrangement, sampleRate, { P1: mix, P2: mix, TR: mix, NO: mix });
  return scaleToPeak(mix);
}

/**
 * Render an arrangement with a sound pack, one stem per channel.
 *
 * The stems are the pack's render taken apart: added sample by sample they give
 * `renderPack(packId, arrangement, sampleRate)`, up to float32 rounding, so together they peak
 * at -3 dBFS. The NES stems carry the chip's channel gains (`CHANNEL_GAINS`).
 * @param {string} packId one of the ids of SOUND_PACKS
 * @param {import("./chip-synth.js").ChipArrangement} arrangement the tempo and the channels' notes, in beats
 * @param {number} [sampleRate] samples per second (default 44,100)
 * @returns {Stems} four stems of `renderLength(arrangement, sampleRate)` samples
 * @throws {Error} for an unknown pack
 * @example
 * const stems = renderPackStems("gameboy", arrangement, 44100);
 * stems.TR.length === renderLength(arrangement, 44100); // true: the bass, alone
 * // stems.P1[i] + stems.P2[i] + stems.TR[i] + stems.NO[i] ≈ renderPack("gameboy", arrangement, 44100)[i]
 */
export function renderPackStems(packId, arrangement, sampleRate = SAMPLE_RATE) {
  if (packId === "nes-raw") return scaleStemsToPeak(renderChipStems(arrangement, sampleRate), CHANNEL_GAINS);
  if (packId === "nes") return softNesStems(arrangement, sampleRate);
  if (packId === "megadrive") return scaleStemsToPeak(renderMegaDriveStems(arrangement, sampleRate), UNIT_GAINS);
  if (packId === "snes") return scaleStemsToPeak(renderSnesStems(arrangement, sampleRate), UNIT_GAINS);
  const length = renderLength(arrangement, sampleRate);
  if (packId === "plain") return scaleStemsToPeak(plainStems(arrangement, sampleRate, length), UNIT_GAINS);
  const pack = oscillatorPack(packId);
  /** @type {Record<ChannelName, Float64Array>} */
  const stems = {
    P1: new Float64Array(length),
    P2: new Float64Array(length),
    TR: new Float64Array(length),
    NO: new Float64Array(length),
  };
  renderOscillators(pack, arrangement, sampleRate, stems);
  return scaleStemsToPeak(stems, UNIT_GAINS);
}

/**
 * The stems added together, as one render.
 * @param {Stems} stems four stems of one length
 * @returns {Float32Array}
 */
function sumOfStems(stems) {
  const mix = new Float32Array(stems.P1.length);
  for (let i = 0; i < mix.length; i++) mix[i] = stems.P1[i] + stems.P2[i] + stems.TR[i] + stems.NO[i];
  return mix;
}

/**
 * What makes the NES chip pack softer than the chip (see the header): the pulse widths, the
 * level balance and the filters, with the cutoffs in Hz.
 * @type {Readonly<{duty: Readonly<{P1: number, P2: number}>, gains: Readonly<Record<ChannelName, number>>, highpassHz: number, consoleLowpassHz: number, speakerLowpassHz: number}>}
 * @example
 * NES_SOFTENING.duty; // { P1: 0.25, P2: 0.5 }
 */
export const NES_SOFTENING = Object.freeze({
  duty: Object.freeze({ P1: 0.25, P2: 0.5 }),
  // The chip's own balance, with three touches. P2: a 50% pulse has about 1.5 times the RMS of a
  // 12.5% one, so it goes down. TR and NO: the 90 Hz high-pass takes some of the bass away and
  // the low-passes take the highs of the noise away, so they come up by 2 to 3 dB to stay level
  // with the pulses.
  gains: Object.freeze({ P1: CHANNEL_GAINS.P1, P2: 0.6, TR: CHANNEL_GAINS.TR * 1.3, NO: CHANNEL_GAINS.NO * 1.4 }),
  highpassHz: 90,
  consoleLowpassHz: 14000,
  speakerLowpassHz: 4000,
});

/**
 * The softened NES chip as stems: the chip's channels with P2 on a rounder pulse, each one
 * through the console's output filters and a small speaker's low-pass, then scaled to peak at
 * -3 dBFS together. A filter whose cutoff lies too near half the sample rate is skipped.
 * @param {import("./chip-synth.js").ChipArrangement} arrangement
 * @param {number} sampleRate
 * @returns {Stems}
 */
function softNesStems(arrangement, sampleRate) {
  const { duty, gains, highpassHz, consoleLowpassHz, speakerLowpassHz } = NES_SOFTENING;
  const chip = renderChipStems(arrangement, sampleRate, { duty });
  /** @type {Record<ChannelName, Float64Array>} */
  const filtered = { P1: new Float64Array(0), P2: new Float64Array(0), TR: new Float64Array(0), NO: new Float64Array(0) };
  for (const channel of CHANNELS) {
    // Float64 keeps the filters' rounding out of the result; the stems come back as float32
    const stem = Float64Array.from(chip[channel]);
    highpass(stem, highpassHz, sampleRate);
    if (consoleLowpassHz < 0.45 * sampleRate) lowpass(stem, consoleLowpassHz, sampleRate);
    if (speakerLowpassHz < 0.45 * sampleRate) biquadLowpass(stem, speakerLowpassHz, sampleRate);
    filtered[channel] = stem;
  }
  return scaleStemsToPeak(filtered, gains);
}

/**
 * @param {string} packId
 * @returns {OscillatorPack}
 * @throws {Error} for an unknown pack
 */
function oscillatorPack(packId) {
  const pack = OSCILLATOR_PACKS[packId];
  if (!pack) throw new Error(`unknown sound pack "${packId}"`);
  return pack;
}

/**
 * Stems times their gains, all scaled by one factor so that their sum peaks at -3 dBFS, as the
 * pack's render does. Silent stems stay zeros.
 * @param {Record<ChannelName, ArrayLike<number>>} stems on one common scale, of equal length
 * @param {Readonly<Record<ChannelName, number>>} gains each stem's gain in the pack's mix
 * @returns {Stems} new arrays
 */
function scaleStemsToPeak(stems, gains) {
  const { P1, P2, TR, NO } = stems;
  let peak = 0;
  for (let i = 0; i < P1.length; i++) {
    peak = Math.max(peak, Math.abs(gains.P1 * P1[i] + gains.P2 * P2[i] + gains.TR * TR[i] + gains.NO * NO[i]));
  }
  const scale = peak > 0 ? PEAK_LEVEL / peak : 0;
  /** @type {Partial<Stems>} */
  const scaled = {};
  for (const channel of CHANNELS) {
    const stem = stems[channel];
    const factor = gains[channel] * scale;
    const samples = new Float32Array(stem.length);
    for (let i = 0; i < stem.length; i++) samples[i] = stem[i] * factor;
    scaled[channel] = samples;
  }
  return /** @type {Stems} */ (scaled);
}

/**
 * The arrangement as plain-synth voices: P1 is the melody, P2 and TR the other voices, NO the
 * drum hits.
 *
 * @param {import("./chip-synth.js").ChipArrangement} arrangement
 * @returns {import("./plain-synth.js").Voices}
 * @example
 * arrangementVoices({ tempoBpm: 120, channels: { P1: [{ pitch: 72, onset: 0, duration: 1, velocity: 100 }] } }).melody;
 * // [{ pitch: 72, onset: 0, duration: 1 }]
 */
export function arrangementVoices(arrangement) {
  const notes = (/** @type {"P1" | "P2" | "TR"} */ channel) =>
    (arrangement.channels[channel] ?? []).map(({ pitch, onset, duration }) => ({ pitch, onset, duration }));
  return {
    melody: notes("P1"),
    others: [notes("P2"), notes("TR")],
    drums: (arrangement.channels.NO ?? []).map(({ pitch, onset }) => ({ pitch, onset })),
  };
}

/**
 * @param {import("./chip-synth.js").ChipArrangement} arrangement
 * @param {number} sampleRate
 * @param {number} length samples to return
 * @returns {Float32Array}
 */
function renderPlain(arrangement, sampleRate, length) {
  const durationBeats = (length / sampleRate) * (arrangement.tempoBpm / 60);
  const rendered = renderVoices(arrangementVoices(arrangement), arrangement.tempoBpm, sampleRate, durationBeats);
  // The plain synthesizer rounds the length from beats; the chip timeline is the reference.
  const samples = new Float32Array(length);
  samples.set(rendered.subarray(0, length));
  return samples;
}

/**
 * The plain pack's four voices mixed apart, before the peak scale: the melody (P1), the two
 * other voices (P2 and TR) and the drum hits (NO).
 * @param {import("./chip-synth.js").ChipArrangement} arrangement
 * @param {number} sampleRate
 * @param {number} length samples of each stem
 * @returns {Record<ChannelName, Float64Array>}
 */
function plainStems(arrangement, sampleRate, length) {
  const durationBeats = (length / sampleRate) * (arrangement.tempoBpm / 60);
  const { melody, others, drums } = arrangementVoices(arrangement);
  const mixAlone = (/** @type {import("./plain-synth.js").Voices} */ voices) => {
    const mix = mixVoices(voices, arrangement.tempoBpm, sampleRate, durationBeats);
    const stem = new Float64Array(length); // the chip timeline is the reference, as in renderPlain
    stem.set(mix.subarray(0, length));
    return stem;
  };
  return {
    P1: mixAlone({ melody, others: [], drums: [] }),
    P2: mixAlone({ melody: [], others: [others[0]], drums: [] }),
    TR: mixAlone({ melody: [], others: [others[1]], drums: [] }),
    NO: mixAlone({ melody: [], others: [], drums }),
  };
}

/**
 * Render the channels with a pack's oscillators, envelopes and drums, each channel into its
 * buffer in `outputs`, then filter every buffer.
 *
 * Giving every channel the same buffer mixes them; giving each its own makes stems. The filter
 * is linear, so filtering each stem and adding them equals filtering the mix.
 * @param {OscillatorPack} pack
 * @param {import("./chip-synth.js").ChipArrangement} arrangement
 * @param {number} sampleRate
 * @param {Record<ChannelName, Float64Array>} outputs where each channel is added, all of one length
 * @returns {void}
 */
function renderOscillators(pack, arrangement, sampleRate, outputs) {
  const secondsPerBeat = 60 / arrangement.tempoBpm;
  for (const channel of /** @type {const} */ (["P1", "P2", "TR"])) {
    const voice = pack.voices[channel];
    for (const { start, end, note } of sounding(arrangement.channels[channel] ?? [], secondsPerBeat)) {
      addNote(outputs[channel], voice, note.pitch, note.velocity, start, end, sampleRate);
    }
  }
  const random = createRandom(NOISE_SEED);
  for (const { start, end, note } of sounding(arrangement.channels.NO ?? [], secondsPerBeat)) {
    const drum = pack.drums[note.pitch] ?? pack.drums[38];
    if (drum) addDrum(outputs.NO, drum, note.velocity, start, end, sampleRate, random);
  }
  if (pack.lowpassHz === null) return;
  for (const output of new Set(Object.values(outputs))) lowpass(output, pack.lowpassHz, sampleRate);
}

/**
 * Add one pitched note: the wave at the note's frequency, shaped by the voice's envelope.
 * @param {Float64Array} mix
 * @param {VoiceSound} voice
 * @param {number} pitch
 * @param {number} velocity
 * @param {number} start seconds
 * @param {number} end seconds
 * @param {number} sampleRate
 */
function addNote(mix, voice, pitch, velocity, start, end, sampleRate) {
  const first = Math.round(start * sampleRate);
  const last = Math.min(mix.length, Math.round(end * sampleRate));
  const frequency = noteFrequency(pitch);
  const seconds = (last - first) / sampleRate;
  let loudness = velocity / 127;
  if (voice.volumeSteps) loudness = Math.max(1, Math.round(loudness * voice.volumeSteps)) / voice.volumeSteps;
  for (let i = first; i < last; i++) {
    const t = (i - first) / sampleRate;
    const phase = (t * frequency) % 1;
    mix[i] += voice.gain * loudness * envelope(voice, t, seconds) * voice.wave(phase);
  }
}

/**
 * The level of an ADSR envelope at time t of a note that lasts `seconds`: a linear attack, a
 * linear decay to the sustain level, and a release that ends with the note.
 * @param {VoiceSound} voice
 * @param {number} t
 * @param {number} seconds
 */
function envelope(voice, t, seconds) {
  let level;
  if (t < voice.attack) level = t / voice.attack;
  else if (voice.decay > 0 && t < voice.attack + voice.decay) {
    level = 1 - (1 - voice.sustain) * ((t - voice.attack) / voice.decay);
  } else level = voice.sustain;
  const untilEnd = seconds - t;
  if (untilEnd < voice.release) level *= Math.max(0, untilEnd / voice.release);
  return level;
}

/**
 * Add one drum hit: noise or a falling tone with an exponential decay of 40 dB over `decay`
 * seconds, cut by the next hit.
 * @param {Float64Array} mix
 * @param {DrumSound} drum
 * @param {number} velocity
 * @param {number} start seconds
 * @param {number} nextStart seconds of the next hit (the note end otherwise)
 * @param {number} sampleRate
 * @param {import("../core/random.js").Random} random
 */
function addDrum(mix, drum, velocity, start, nextStart, sampleRate, random) {
  const first = Math.round(start * sampleRate);
  const hitEnd = Math.min(start + drum.decay, Math.max(nextStart, start + 0.01));
  const last = Math.min(mix.length, Math.round(hitEnd * sampleRate));
  const n = last - first;
  if (n <= 0) return;
  const gain = drum.gain * (velocity / 127);
  const fallPerSecond = Math.log(100) / drum.decay; // 40 dB over the decay
  /** @type {Float64Array} */
  let tone;
  if (drum.kind === "lfsr") {
    tone = noiseWave(n, drum.period, drum.shortMode, sampleRate);
  } else if (drum.kind === "white") {
    tone = new Float64Array(n);
    for (let i = 0; i < n; i++) tone[i] = 2 * random.float() - 1;
    lowpass(tone, drum.lowpassHz, sampleRate);
  } else {
    tone = new Float64Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      const frequency = drum.toHz + (drum.fromHz - drum.toHz) * Math.exp(-t * 30);
      phase = (phase + frequency / sampleRate) % 1;
      tone[i] = WAVES.sine(phase);
    }
  }
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, (n - i) / (0.002 * sampleRate)); // avoid a click when a hit is cut
    mix[first + i] += gain * Math.exp(-fallPerSecond * (i / sampleRate)) * fade * tone[i];
  }
}
