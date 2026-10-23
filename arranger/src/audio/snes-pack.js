// @ts-check
// The Super Nintendo sound pack: the arrangement played with sampled-sounding voices, the
// Gaussian softness of the S-DSP and its echo (`snes-dsp.js` explains the engine).
//
// A real SNES game ships recordings of instruments: a flute, a harp, a bass guitar, a drum
// kit. This project may not use any game's samples, and has no recordings of its own, so the
// pack makes its samples in code, as sums of sine partials (`additiveSample`), the way an
// additive synthesizer would, and plays them through the same pipeline a game's samples go
// through: stepped through at the note's pitch, looped, shaped by an ADSR envelope, softened by
// the Gaussian interpolation, and sent to the echo. What it keeps from the console is that
// pipeline and the mellow, slightly dreamy sound it gives. The sound of the real samples
// (their noise, the compression of the BRR format to 4 bits per sample) is not imitated.
//
// - P1, the melody: a soft flute-and-strings lead. The sample is a stack of nine harmonics with
//   a gentle roll-off, doubled by a copy 13.5 cents sharp (an ensemble chorus), after a short
//   breath of noise at the start. The loop is 128 cycles long so that the chorus pair closes
//   its loop (the second copy makes 129 cycles in it). A slow attack, and a vibrato that a game's
//   music driver would add by wobbling the pitch register, make it sing.
// - P2, the harmony: a harp-like pluck. The sample is a second long of twelve harmonics that
//   die away faster the higher they are, like a plucked string, followed by a short loop that
//   holds what is left. Because a sample is played faster to play it higher, the pluck of a high
//   note is shorter than a low one's, as with a real sampled instrument.
// - TR, the bass: a round fingered bass. A short intro with a few harmonics that fade in
//   0.2 s, the "pluck", and a loop of the fundamental and its second harmonic.
// - NO, the drums: three one-shot samples, a falling sine for the kick, filtered noise with a
//   tone for the snare, and a short burst of high noise for the hi-hat. Played through the
//   Gaussian filter they are soft.
// - The echo: melody and harmony are sent to the echo, 96 ms (6 × 16 ms) delay, 45% feedback and
//   a low-pass FIR filter, so they trail away into a soft room; the bass and the drums stay dry
//   (almost: the hats get a little), as a composer would set it so the beat stays clear.
//
// Everything is rendered at the DSP's 32,000 samples per second, then converted to the sound
// card's rate (`resampleTo`). Working at 32 kHz is part of the character (nothing above 16 kHz)
// and is faster, too. The samples have few high harmonics and the Gaussian filter takes more of
// them away, so the pack is mellow by design. An arrangement repeats itself, so each distinct
// note (pitch, length, velocity) is rendered once and added wherever it occurs.

import { renderLength } from "./chip-synth.js";
import { noteFrequency, sounding } from "./note-schedule.js";
import { createRandom } from "../core/random.js";
import { DSP_RATE, adsrLevel, echo, playSample, resampleTo } from "./snes-dsp.js";

/** @typedef {import("./chip-synth.js").ChannelName} ChannelName */
/** @typedef {import("./snes-dsp.js").Adsr} Adsr */

/**
 * A sample with the pitch it was made at.
 * @typedef {import("./snes-dsp.js").DspSample & {baseHz: number}} PitchedSample
 */

/**
 * One partial of an additive sample.
 * @typedef {object} Partial
 * @property {number} ratio frequency as a multiple of the base frequency; ratio × loop cycles must be a whole number
 * @property {number} amp level, before the sample is normalized
 * @property {number} [decay] seconds for the partial to fall by a factor of e in the intro (default: no decay)
 */

/**
 * @typedef {object} AdditiveSpec
 * @property {number} baseHz the pitch of the sample; 32,000 / baseHz must be a whole number
 * @property {number} introSeconds the part before the loop
 * @property {number} loopCycles how many cycles of the base frequency the loop lasts
 * @property {Partial[]} partials
 * @property {{amp: number, decay: number, seed: number}} [breath] noise in the intro, lowpassed, that fades by `decay` seconds
 */

// Samples are normalized to this peak, leaving a little room as a DSP's 16-bit range would.
const SAMPLE_PEAK = 0.9;

/**
 * Make a looped sample from sine partials: an intro, where the partials may decay, and a loop
 * that repeats a whole number of cycles of every partial so that it closes without a click.
 *
 * The partials that decay in the intro keep the level they had at the end of it for the whole
 * loop, so the level has no jump at the loop point.
 * @param {AdditiveSpec} spec
 * @returns {PitchedSample}
 * @throws {Error} when the base frequency is not a whole number of samples per cycle, or a
 *   partial does not make a whole number of cycles in the loop
 * @example
 * // A 400 Hz tone and its octave, a 50 ms intro and a loop of 4 cycles (320 samples)
 * additiveSample({ baseHz: 400, introSeconds: 0.05, loopCycles: 4, partials: [{ ratio: 1, amp: 1 }, { ratio: 2, amp: 0.5 }] });
 */
export function additiveSample({ baseHz, introSeconds, loopCycles, partials, breath }) {
  const period = DSP_RATE / baseHz;
  if (!Number.isInteger(period)) throw new Error(`${baseHz} Hz is not a whole number of samples per cycle at ${DSP_RATE} Hz`);
  for (const { ratio } of partials) {
    const cycles = ratio * loopCycles;
    if (Math.abs(cycles - Math.round(cycles)) > 1e-9) throw new Error(`a partial at ratio ${ratio} does not make a whole number of cycles in a loop of ${loopCycles}`);
  }
  const loopStart = Math.round(introSeconds * DSP_RATE);
  const length = loopStart + period * loopCycles;
  const data = new Float64Array(length);
  const frozenAt = loopStart / DSP_RATE;
  for (const { ratio, amp, decay } of partials) {
    for (let n = 0; n < length; n++) {
      const level = decay === undefined ? amp : amp * Math.exp(-Math.min(n / DSP_RATE, frozenAt) / decay);
      data[n] += level * Math.sin((2 * Math.PI * ratio * n) / period);
    }
  }
  if (breath) {
    const random = createRandom(breath.seed);
    let smooth = 0;
    for (let n = 0; n < loopStart; n++) {
      smooth += 0.3 * (2 * random.float() - 1 - smooth); // noise with the highs taken off
      data[n] += breath.amp * smooth * Math.exp(-n / DSP_RATE / breath.decay) * (1 - n / loopStart);
    }
  }
  return { data: normalized(data), loopStart, baseHz };
}

/**
 * @param {Float64Array} data
 * @param {number} [peak]
 * @returns {Float64Array} the same array, scaled so that its largest sample is `peak`
 */
function normalized(data, peak = SAMPLE_PEAK) {
  let largest = 0;
  for (const value of data) largest = Math.max(largest, Math.abs(value));
  if (largest > 0) for (let i = 0; i < data.length; i++) data[i] *= peak / largest;
  return data;
}

// --- The samples -------------------------------------------------------------------------------

/** A decaying exponential's value at sample n for a time constant in seconds. */
const fall = (/** @type {number} */ n, /** @type {number} */ seconds) => Math.exp(-n / DSP_RATE / seconds);

/** The lead's harmonics: a flute's roll-off, 9 partials, each doubled by a copy 129/128 higher. */
const LEAD_PARTIALS = [1, 0.55, 0.28, 0.14, 0.08, 0.05, 0.03, 0.02, 0.01].flatMap((amp, index) => [
  { ratio: index + 1, amp },
  { ratio: ((index + 1) * 129) / 128, amp: amp * 0.7 },
]);

/** The harp's twelve harmonics: each falls faster than the one below it. */
const HARP_PARTIALS = Array.from({ length: 12 }, (_, index) => ({
  ratio: index + 1,
  amp: 1 / (index + 1) ** 0.9,
  decay: 0.9 / (1 + 0.7 * index),
}));

/** The bass: a fundamental and a second harmonic that stay, a few more that fade in 0.2 s. */
const BASS_PARTIALS = [
  { ratio: 1, amp: 1 },
  { ratio: 2, amp: 0.5, decay: 0.8 },
  { ratio: 3, amp: 0.3, decay: 0.25 },
  { ratio: 4, amp: 0.18, decay: 0.15 },
  { ratio: 5, amp: 0.1, decay: 0.1 },
  { ratio: 6, amp: 0.06, decay: 0.08 },
];

/**
 * A falling sine, the kick drum.
 * @returns {import("./snes-dsp.js").DspSample}
 */
function kickSample() {
  const data = new Float64Array(Math.round(0.35 * DSP_RATE));
  let phase = 0;
  for (let n = 0; n < data.length; n++) {
    phase += (45 + 90 * fall(n, 0.04)) / DSP_RATE;
    data[n] = Math.sin(2 * Math.PI * phase) * fall(n, 0.12) * (1 - fall(n, 0.001));
  }
  return { data: normalized(data, 0.95), loopStart: null };
}

/**
 * Soft noise with a short tone: the snare.
 * @returns {import("./snes-dsp.js").DspSample}
 */
function snareSample() {
  const random = createRandom(2603);
  const data = new Float64Array(Math.round(0.3 * DSP_RATE));
  let smooth = 0;
  for (let n = 0; n < data.length; n++) {
    smooth += 0.5 * (2 * random.float() - 1 - smooth);
    data[n] = smooth * fall(n, 0.06) + 0.6 * Math.sin((2 * Math.PI * 185 * n) / DSP_RATE) * fall(n, 0.04);
  }
  return { data: normalized(data, 0.95), loopStart: null };
}

/**
 * A short burst of high-passed noise: the hi-hat.
 * @returns {import("./snes-dsp.js").DspSample}
 */
function hatSample() {
  const random = createRandom(4301);
  const data = new Float64Array(Math.round(0.12 * DSP_RATE));
  let previous = 0;
  for (let n = 0; n < data.length; n++) {
    const noise = 2 * random.float() - 1;
    data[n] = (noise - previous) * fall(n, 0.02); // the difference of neighbours: a high-pass
    previous = noise;
  }
  return { data: normalized(data, 0.95), loopStart: null };
}

/**
 * The pack's samples, made when the module loads. They are the same every time.
 * @type {Readonly<{P1: PitchedSample, P2: PitchedSample, TR: PitchedSample, kick: import("./snes-dsp.js").DspSample, snare: import("./snes-dsp.js").DspSample, hat: import("./snes-dsp.js").DspSample}>}
 * @example
 * SNES_SAMPLES.P2.baseHz; // 320: the pitch the harp sample was made at
 */
export const SNES_SAMPLES = Object.freeze({
  P1: additiveSample({ baseHz: 400, introSeconds: 0.12, loopCycles: 128, partials: LEAD_PARTIALS, breath: { amp: 0.12, decay: 0.04, seed: 77 } }),
  P2: additiveSample({ baseHz: 320, introSeconds: 1, loopCycles: 8, partials: HARP_PARTIALS }),
  TR: additiveSample({ baseHz: 80, introSeconds: 0.2, loopCycles: 2, partials: BASS_PARTIALS }),
  kick: kickSample(),
  snare: snareSample(),
  hat: hatSample(),
});

// --- The voices --------------------------------------------------------------------------------

/**
 * How a pitched channel plays its sample.
 * @typedef {object} SnesVoice
 * @property {PitchedSample} sample
 * @property {Adsr} envelope
 * @property {{hz: number, cents: number, delay: number}} [vibrato] pitch wobble starting `delay` seconds into the note
 * @property {number} gain level of the stem
 */

/**
 * The voices of the three pitched channels.
 * @type {Readonly<Record<"P1" | "P2" | "TR", Readonly<SnesVoice>>>}
 * @example
 * SNES_VOICES.P1.envelope.attack; // 0.025
 */
export const SNES_VOICES = Object.freeze({
  P1: Object.freeze({
    sample: SNES_SAMPLES.P1,
    envelope: { attack: 0.025, decay: 0.15, sustain: 0.85, sustainFall: 8, release: 0.06 },
    vibrato: { hz: 5.4, cents: 12, delay: 0.3 },
    gain: 0.9,
  }),
  P2: Object.freeze({
    sample: SNES_SAMPLES.P2,
    envelope: { attack: 0.002, decay: 0.45, sustain: 0.4, sustainFall: 1.5, release: 0.08 },
    gain: 0.5,
  }),
  TR: Object.freeze({
    sample: SNES_SAMPLES.TR,
    envelope: { attack: 0.003, decay: 0.2, sustain: 0.8, sustainFall: 6, release: 0.05 },
    gain: 1,
  }),
});

/**
 * The echo: the delay line is 6 × 16 ms long, a share 0.45 of the echo is fed back, and the FIR
 * filter is a low-pass (its taps add up to 1, so a steady tone comes back at the same level). `wet` is how much
 * of each channel's echo is mixed in; the bass sends nothing.
 * @type {Readonly<{delay: number, feedback: number, fir: readonly number[], wet: Readonly<Record<ChannelName, number>>}>}
 */
export const SNES_ECHO = Object.freeze({
  delay: 6 * 512,
  feedback: 0.45,
  fir: Object.freeze([0.2, 0.25, 0.22, 0.15, 0.1, 0.05, 0.02, 0.01]),
  wet: Object.freeze({ P1: 0.35, P2: 0.5, TR: 0, NO: 0.12 }),
});

// The level of the drum stem.
const DRUM_GAIN = 0.4;

// Samples between recomputations of the envelope (1 ms); the values between are interpolated.
const ENVELOPE_BLOCK = 32;

// The fade at the end of a note or drum hit that is cut while still audible, in DSP samples (2 ms).
const CUT_FADE = 64;

/**
 * One note of a voice at the DSP rate: the sample stepped to the note's pitch, shaped by the
 * envelope, with the release tail the next note leaves room for.
 * @param {Readonly<SnesVoice>} voice
 * @param {{heldSamples: number, tailSamples: number, velocity: number, pitch: number}} note lengths in samples at the DSP rate
 * @returns {Float64Array} `heldSamples + tailSamples` samples
 */
function renderVoiceNote(voice, { heldSamples, tailSamples, velocity, pitch }) {
  const step = noteFrequency(pitch) / voice.sample.baseHz;
  const seconds = heldSamples / DSP_RATE;
  const length = heldSamples + tailSamples;
  const { vibrato } = voice;
  const pitchStep = vibrato
    ? (/** @type {number} */ t) => step * 2 ** (t > vibrato.delay ? (vibrato.cents * Math.sin(2 * Math.PI * vibrato.hz * (t - vibrato.delay))) / 1200 : 0)
    : step;
  const note = playSample(voice.sample, pitchStep, length);
  const loudness = (velocity / 127) * voice.gain;
  let levelEnd = adsrLevel(voice.envelope, 0, seconds);
  for (let block = 0; block < length; block += ENVELOPE_BLOCK) {
    const levelStart = levelEnd;
    levelEnd = adsrLevel(voice.envelope, (block + ENVELOPE_BLOCK) / DSP_RATE, seconds);
    const last = Math.min(length, block + ENVELOPE_BLOCK);
    for (let i = block; i < last; i++) {
      note[i] *= (levelStart + ((levelEnd - levelStart) * (i - block)) / ENVELOPE_BLOCK) * loudness;
    }
  }
  if (tailSamples < voice.envelope.release * DSP_RATE) fadeOut(note, length);
  return note;
}

/**
 * Add `samples` into `target` from `first` on, dropping what runs past its end.
 * @param {Float64Array} target
 * @param {Float64Array} samples
 * @param {number} first
 */
function addInto(target, samples, first) {
  const n = Math.min(samples.length, target.length - first);
  for (let i = 0; i < n; i++) target[first + i] += samples[i];
}

/**
 * Fade the CUT_FADE samples before `end` to silence, in place, where a note was cut while audible.
 * @param {Float64Array} target
 * @param {number} end
 */
function fadeOut(target, end) {
  for (let k = 0; k < CUT_FADE; k++) {
    const i = end - 1 - k;
    if (i >= 0 && i < target.length) target[i] *= k / CUT_FADE;
  }
}

/**
 * The drum sound of each General MIDI drum note (36 kick, 38 snare, 42 hi-hat), played through
 * the DSP at its own rate once and kept.
 * @param {number} pitch
 * @returns {Float64Array}
 */
function playedDrum(pitch) {
  const sample = pitch === 36 ? SNES_SAMPLES.kick : pitch === 42 ? SNES_SAMPLES.hat : SNES_SAMPLES.snare;
  let played = PLAYED_DRUMS.get(sample);
  if (!played) {
    played = playSample(sample, 1, sample.data.length);
    PLAYED_DRUMS.set(sample, played);
  }
  return played;
}

/** @type {Map<object, Float64Array>} */
const PLAYED_DRUMS = new Map();

/**
 * Play the arrangement with the Super Nintendo's voices, one stem per channel, before the peak
 * scale.
 * @param {import("./chip-synth.js").ChipArrangement} arrangement
 * @param {number} sampleRate
 * @returns {Record<ChannelName, Float64Array>} four stems of `renderLength(arrangement, sampleRate)`
 *   samples, with the channel levels inside them
 * @example
 * renderSnesStems({ tempoBpm: 120, channels: { TR: [{ pitch: 40, onset: 0, duration: 1, velocity: 100 }] } }, 44100).TR.length; // 28665
 */
export function renderSnesStems(arrangement, sampleRate) {
  const length = renderLength(arrangement, sampleRate);
  const dspLength = Math.ceil((length / sampleRate) * DSP_RATE) + 8;
  const secondsPerBeat = 60 / arrangement.tempoBpm;
  /** @type {Record<ChannelName, Float64Array>} */
  const dsp = {
    P1: new Float64Array(dspLength),
    P2: new Float64Array(dspLength),
    TR: new Float64Array(dspLength),
    NO: new Float64Array(dspLength),
  };
  // An arrangement repeats itself, and a note's sound does not depend on when it starts, so each
  // distinct note is rendered once and added wherever it occurs.
  /** @type {Map<string, Float64Array>} */
  const rendered = new Map();
  for (const channel of /** @type {const} */ (["P1", "P2", "TR"])) {
    const voice = SNES_VOICES[channel];
    const played = sounding(arrangement.channels[channel] ?? [], secondsPerBeat);
    played.forEach(({ start, end, note }, index) => {
      const heldSamples = Math.round((end - start) * DSP_RATE);
      if (heldSamples <= 0) return;
      // A voice plays one note at a time: the release may ring until the next note starts
      const gapSamples = index + 1 < played.length ? Math.max(0, Math.round((played[index + 1].start - end) * DSP_RATE)) : Infinity;
      const tailSamples = Math.min(gapSamples, Math.round(voice.envelope.release * DSP_RATE));
      const key = `${channel}|${note.pitch}|${heldSamples}|${note.velocity}|${tailSamples}`;
      let samples = rendered.get(key);
      if (!samples) {
        samples = renderVoiceNote(voice, { heldSamples, tailSamples, velocity: note.velocity, pitch: note.pitch });
        rendered.set(key, samples);
      }
      addInto(dsp[channel], samples, Math.round(start * DSP_RATE));
    });
  }
  for (const { start, end, note } of sounding(arrangement.channels.NO ?? [], secondsPerBeat)) {
    const hit = playedDrum(note.pitch);
    const first = Math.round(start * DSP_RATE);
    const n = Math.min(hit.length, Math.max(CUT_FADE, Math.round((end - start) * DSP_RATE)), dspLength - first);
    for (let i = 0; i < n; i++) dsp.NO[first + i] += hit[i] * (note.velocity / 127) * DRUM_GAIN;
    if (n < hit.length) fadeOut(dsp.NO, first + n);
  }
  // The echo, then the conversion to the sound card's rate
  /** @type {Partial<Record<ChannelName, Float64Array>>} */
  const stems = {};
  for (const channel of /** @type {const} */ (["P1", "P2", "TR", "NO"])) {
    const wet = SNES_ECHO.wet[channel];
    if (wet > 0) {
      const repeats = echo(dsp[channel], SNES_ECHO);
      for (let i = 0; i < repeats.length; i++) dsp[channel][i] += wet * repeats[i];
    }
    stems[channel] = resampleTo(dsp[channel], sampleRate, length);
  }
  return /** @type {Record<ChannelName, Float64Array>} */ (stems);
}
