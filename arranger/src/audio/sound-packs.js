// @ts-check
// Sound packs: the same arrangement played with the sound of other chips (spec 004).
//
// The arrangement is written for the NES, but its four lines (melody, harmony, bass, drums) can be
// voiced by other machines, the way a cover changes instruments. Each pack keeps the notes and
// the timeline of the NES render (`renderLength`), so the player switches packs at the same
// second, and changes only how each note sounds:
//
// - NES chip: the chip synthesizer of `chip-synth.js`, unchanged.
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
// These are impressions of each chip made with simple oscillators, not cycle-exact emulations.
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
import { mixVoices, renderVoices } from "./plain-synth.js";
import { createRandom } from "../core/random.js";

/** @typedef {import("./chip-synth.js").ChannelName} ChannelName */

/**
 * One track per channel of the arrangement, all of the same length and on one scale.
 * @typedef {Record<ChannelName, Float32Array>} Stems
 */

/**
 * One sound pack, as the page lists it.
 * @typedef {object} SoundPack
 * @property {string} id "nes", "gameboy", "c64", "soft" or "plain"
 * @property {string} name the name shown on the page
 * @property {string} description one line on how it sounds
 */

/**
 * The packs, in the order the page offers them; the NES chip comes first.
 * @type {readonly SoundPack[]}
 * @example
 * SOUND_PACKS.map((pack) => pack.id); // ["nes", "gameboy", "c64", "soft", "plain"]
 */
export const SOUND_PACKS = Object.freeze([
  Object.freeze({
    id: "nes",
    name: "NES chip",
    description: "The NES 2A03: thin pulse waves, a buzzy stepped triangle bass and noise drums.",
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
 * renderPack("nes", arrangement); // the same samples as renderChip(arrangement)
 */
export function renderPack(packId, arrangement, sampleRate = SAMPLE_RATE) {
  if (packId === "nes") return renderChip(arrangement, sampleRate);
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
  if (packId === "nes") return scaleStemsToPeak(renderChipStems(arrangement, sampleRate), CHANNEL_GAINS);
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
 * The notes of one channel with the seconds each one sounds: a channel plays one note at a
 * time, so a note stops when the next one starts.
 * @param {Array<{pitch: number, onset: number, duration: number, velocity: number}>} notes
 * @param {number} secondsPerBeat
 */
function sounding(notes, secondsPerBeat) {
  const ordered = [...notes].sort((a, b) => a.onset - b.onset || b.pitch - a.pitch);
  return ordered.map((note, index) => {
    const start = note.onset * secondsPerBeat;
    const next = index + 1 < ordered.length ? ordered[index + 1].onset * secondsPerBeat : Infinity;
    return { start, end: Math.min((note.onset + note.duration) * secondsPerBeat, next), note };
  });
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
  const frequency = 440 * 2 ** ((pitch - 69) / 12);
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

/**
 * A one-pole low-pass filter, in place: it softens everything above `cutoffHz`.
 * @param {Float64Array} samples
 * @param {number} cutoffHz
 * @param {number} sampleRate
 */
function lowpass(samples, cutoffHz, sampleRate) {
  const alpha = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  let state = 0;
  for (let i = 0; i < samples.length; i++) {
    state += alpha * (samples[i] - state);
    samples[i] = state;
  }
}
