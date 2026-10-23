// @ts-check
// The sound engine of the Super Nintendo: sample playback with a Gaussian filter, an ADSR
// envelope and an echo, after the Sony SPC700 sound system and its S-DSP (1990).
//
// The SNES does not synthesize waves. Its sound chip plays samples, short recordings stored in
// 64 KB of RAM, on 8 voices, and a game's music is a program that picks a sample for each voice
// and tells it a pitch, a volume envelope and whether it echoes. The DSP runs at 32,000 samples
// per second and has four parts that give the console its sound:
//
// - Pitch by resampling. A sample is recorded at some pitch; to play it higher the DSP steps
//   through it faster, to play it lower, slower. The step is a 14-bit number in units of 1/4096
//   of a sample (4096 = as recorded), so it can go from 0 up to just under four times faster
//   (`quantizePitch`). A sample that has a loop plays its intro once and then repeats the loop
//   for as long as the note lasts; that is how a short recording makes a long note.
// - Gaussian interpolation (`gaussianWeights`, `playSample`). A step usually lands between two
//   samples, so the DSP computes the value there from four neighbouring samples, with weights
//   from a bell-shaped (Gaussian) table. A Gaussian is smooth, which makes it a low-pass
//   filter: even when a step lands exactly on a sample, the neighbours still contribute, so the
//   treble is rounded off (a tone at 16 kHz loses about 11 dB). That mellowness is much of what
//   people call the SNES sound. The real table has 512 entries from measurements; here its
//   shape is a Gaussian with the width that gives the real weights on a sample, about 18% for
//   each neighbour and 64% for the sample itself.
// - ADSR envelope (`adsrLevel`): attack, decay, sustain and release, the shape of a note's
//   loudness. The attack rises linearly; the decay falls exponentially (steady in dB) to the
//   sustain level; the sustain can go on falling slowly; the release, after the key goes up,
//   falls linearly to silence.
// - Echo (`echo`): the DSP can send voices to a delay line in RAM and mix the delayed sound back
//   in. The delay is a multiple of 16 ms. What comes back goes through an 8-tap FIR filter (a
//   weighted sum of the last 8 samples, here a low-pass) and part of it is fed back into the
//   delay line, so each repeat is quieter and darker than the one before. Games use it as a
//   cheap reverb.
//
// This module is the engine; the sounds that play through it (the samples, made here with sine
// waves, never copied from a game) and the arrangement of the voices are in `snes-pack.js`. The
// code is pure and deterministic. The BRR compression of the real console (4 bits per sample)
// and its integer arithmetic are not copied: this is an impression of the chip, not an emulation.

/**
 * A sample in the DSP's memory: the recording and where its loop starts.
 * @typedef {object} DspSample
 * @property {Float64Array} data the samples, at the DSP rate
 * @property {number | null} loopStart the index where the loop begins and runs to the end of the
 *   data, or null for a one-shot sample that falls silent at its end
 */

/**
 * The ADSR envelope of a voice.
 * @typedef {object} Adsr
 * @property {number} attack seconds to rise from silence to full level
 * @property {number} decay seconds to fall from full level to the sustain level
 * @property {number} sustain the level held after the decay, above 0 and up to 1
 * @property {number} sustainFall seconds for the sustain to fall by 40 dB (Infinity holds it)
 * @property {number} release seconds, after the key goes up, to fall to silence
 */

/**
 * The echo's settings.
 * @typedef {object} EchoSettings
 * @property {number} delay in samples at the DSP rate (a multiple of 512, which is 16 ms)
 * @property {number} feedback how much of the echo goes back into the delay line, 0 to below 1
 * @property {ArrayLike<number>} fir the 8 taps of the filter on the echo, newest sample first
 */

/**
 * The sample rate of the DSP, in samples per second.
 * @example
 * DSP_RATE; // 32000
 */
export const DSP_RATE = 32000;

// The pitch register is 14 bits: 0x1000 (4096) plays the sample at its own rate.
const PITCH_UNIT = 4096;
const PITCH_REGISTER_MAX = 0x3fff;

/**
 * The fastest a sample can be stepped through: 0x3FFF / 4096, just under 4 times its own rate.
 * @example
 * MAX_PITCH_STEP; // 3.99976...
 */
export const MAX_PITCH_STEP = PITCH_REGISTER_MAX / PITCH_UNIT;

// The Gaussian's width, in samples, that gives the real DSP's weights for a step that lands on a
// sample: 64% for the sample and 18% for each neighbour, sigma² = 0.393.
const GAUSSIAN_SIGMA_SQUARED = 0.393;

// The DSP picks the weights from 256 fractions of a sample.
const FRACTIONS = 256;

// Four weights for each of the 256 fractions: the taps are the samples at offsets -1, 0, +1 and
// +2 from the sample just before the position.
const WEIGHTS = new Float64Array(FRACTIONS * 4);
for (let row = 0; row < FRACTIONS; row++) {
  const fraction = row / FRACTIONS;
  let sum = 0;
  for (let tap = 0; tap < 4; tap++) {
    const distance = tap - 1 - fraction;
    WEIGHTS[row * 4 + tap] = Math.exp(-(distance * distance) / (2 * GAUSSIAN_SIGMA_SQUARED));
    sum += WEIGHTS[row * 4 + tap];
  }
  for (let tap = 0; tap < 4; tap++) WEIGHTS[row * 4 + tap] /= sum;
}

/**
 * Round a pitch step to what the 14-bit pitch register can hold: a multiple of 1/4096, at most
 * `MAX_PITCH_STEP`.
 * @param {number} step 1 plays the sample at the rate it was recorded
 * @returns {number}
 * @example
 * quantizePitch(1.5 + 0.4 / 4096); // 1.5
 * quantizePitch(9); // 3.99975..., the fastest the chip can go
 */
export function quantizePitch(step) {
  return Math.min(PITCH_REGISTER_MAX, Math.max(0, Math.round(step * PITCH_UNIT))) / PITCH_UNIT;
}

/**
 * The four interpolation weights for a position between two samples. They are positive and sum
 * to 1.
 * @param {number} fraction how far past the sample at offset 0 the position is, from 0 to just
 *   under 1 (the DSP uses 256 steps of it)
 * @returns {[number, number, number, number]} the weights of the samples at offsets -1, 0, +1, +2
 * @example
 * gaussianWeights(0); // [0.18, 0.64, 0.18, 0.00]: the sample itself, softened by its neighbours
 * gaussianWeights(0.5); // [0.04, 0.46, 0.46, 0.04]: halfway between two samples
 */
export function gaussianWeights(fraction) {
  const row = Math.min(FRACTIONS - 1, Math.floor(fraction * FRACTIONS)) * 4;
  return [WEIGHTS[row], WEIGHTS[row + 1], WEIGHTS[row + 2], WEIGHTS[row + 3]];
}

// How many output samples a time-varying pitch is held for, so that it need not be computed at
// every sample: 32 samples is 1 ms.
const PITCH_BLOCK = 32;

/**
 * Play a sample through the DSP's pitch, looping and Gaussian interpolation, from the start of
 * the sample, at full level (the envelope is applied by the caller).
 *
 * @param {DspSample} sample
 * @param {number | ((seconds: number) => number)} step samples of the recording per output
 *   sample, or a function of the time in seconds for a pitch that changes (vibrato); it is
 *   evaluated every millisecond and rounded to the 14-bit register
 * @param {number} length how many output samples to make
 * @returns {Float64Array} `length` samples at the DSP rate
 * @example
 * // A 64-sample sine cycle loops at 500 Hz; at step 2 it is an octave higher
 * const cycle = Float64Array.from({ length: 64 }, (_, i) => Math.sin((2 * Math.PI * i) / 64));
 * playSample({ data: cycle, loopStart: 0 }, 2, 32000); // 1000 Hz, a little softened
 */
export function playSample(sample, step, length) {
  const { data, loopStart } = sample;
  const size = data.length;
  const loopLength = loopStart === null ? 0 : size - loopStart;
  // The sample with one silent sample before it: the DSP's history starts silent
  const padded = new Float64Array(size + 1);
  padded.set(data, 1);
  /**
   * The sample at any index of the endless stream: the data, then the loop over and over.
   * @param {number} j
   */
  const streamAt = (j) => {
    if (j < 0) return 0;
    if (j < size) return data[j];
    return loopLength > 0 ? data[loopStart + ((j - loopStart) % loopLength)] : 0;
  };
  const output = new Float64Array(length);
  let position = 0;
  let currentStep = typeof step === "number" ? quantizePitch(step) : 0;
  for (let i = 0; i < length; i++) {
    if (typeof step === "function" && i % PITCH_BLOCK === 0) currentStep = quantizePitch(step(i / DSP_RATE));
    const index = Math.floor(position);
    if (index >= size && loopLength === 0) break; // a one-shot sample is over: the rest is silence
    const row = Math.floor((position - index) * FRACTIONS) * 4;
    // The taps are the samples at index - 1 .. index + 2 of the stream
    output[i] =
      index + 2 < size
        ? WEIGHTS[row] * padded[index] + WEIGHTS[row + 1] * padded[index + 1] + WEIGHTS[row + 2] * padded[index + 2] + WEIGHTS[row + 3] * padded[index + 3]
        : WEIGHTS[row] * streamAt(index - 1) + WEIGHTS[row + 1] * streamAt(index) + WEIGHTS[row + 2] * streamAt(index + 1) + WEIGHTS[row + 3] * streamAt(index + 2);
    position += currentStep;
    // Past the end of the data the stream repeats every loopLength samples: keep the number small
    if (loopLength > 0 && position >= size + loopLength) position -= loopLength;
  }
  return output;
}

/**
 * The level of an ADSR envelope at time `t`, from 0 to 1.
 * @param {Adsr} envelope
 * @param {number} t seconds since the key went down
 * @param {number} [releaseAt] when the key goes up, in seconds (default never)
 * @returns {number}
 * @example
 * const piano = { attack: 0, decay: 0.4, sustain: 0.3, sustainFall: 2, release: 0.1 };
 * adsrLevel(piano, 0.4); // 0.3: the decay is over
 * adsrLevel(piano, 2.4); // 0.003: the sustain has fallen 40 dB in the two seconds since
 */
export function adsrLevel(envelope, t, releaseAt = Infinity) {
  const held = heldLevel(envelope, Math.min(t, releaseAt));
  if (t <= releaseAt) return held;
  return held * Math.max(0, 1 - (t - releaseAt) / envelope.release);
}

/**
 * The envelope while the key is down.
 * @param {Adsr} envelope
 * @param {number} t
 * @returns {number}
 */
function heldLevel(envelope, t) {
  if (t < envelope.attack) return t / envelope.attack;
  const afterAttack = t - envelope.attack;
  if (afterAttack < envelope.decay) return envelope.sustain ** (afterAttack / envelope.decay);
  const afterDecay = afterAttack - envelope.decay;
  return envelope.sustain * 0.01 ** (Number.isFinite(envelope.sustainFall) ? afterDecay / envelope.sustainFall : 0);
}

/**
 * The echo of a signal: what comes back from the delay line, to be mixed in (it holds nothing of
 * the input itself, so the first repeat arrives `delay` samples after the sound).
 *
 * The delay line receives the input plus `feedback` times the filtered echo, so with a filter
 * that passes everything the repeats are `feedback` times the one before. With a low-pass
 * filter each repeat is also darker.
 * @param {ArrayLike<number>} input
 * @param {EchoSettings} settings
 * @returns {Float64Array} as long as the input
 * @example
 * // An impulse comes back 1000 samples later at full level, then at half, then at a quarter...
 * echo(impulse, { delay: 1000, feedback: 0.5, fir: [1, 0, 0, 0, 0, 0, 0, 0] });
 */
export function echo(input, { delay, feedback, fir }) {
  const wet = new Float64Array(input.length);
  const line = new Float64Array(delay);
  const [c0, c1, c2, c3, c4, c5, c6, c7] = fir;
  // The last 8 samples read from the delay line, newest first, kept in local variables
  let h0 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0, h7 = 0;
  let cursor = 0;
  for (let i = 0; i < input.length; i++) {
    h7 = h6; h6 = h5; h5 = h4; h4 = h3; h3 = h2; h2 = h1; h1 = h0;
    h0 = line[cursor]; // what went into the line `delay` samples ago
    const filtered = c0 * h0 + c1 * h1 + c2 * h2 + c3 * h3 + c4 * h4 + c5 * h5 + c6 * h6 + c7 * h7;
    wet[i] = filtered;
    line[cursor] = input[i] + feedback * filtered;
    cursor = cursor + 1 === delay ? 0 : cursor + 1;
  }
  return wet;
}

/**
 * Convert a signal from the DSP rate to the sound card's rate with cubic (Catmull-Rom)
 * interpolation. At the DSP rate itself nothing changes.
 * @param {Float64Array} samples at the DSP rate
 * @param {number} sampleRate the rate to convert to
 * @param {number} length how many samples to make; samples past the input are silent
 * @returns {Float64Array} `length` samples
 * @example
 * resampleTo(stem, 44100, 44100 * seconds); // the stem at the sound card's rate
 */
export function resampleTo(samples, sampleRate, length) {
  const output = new Float64Array(length);
  if (sampleRate === DSP_RATE) {
    output.set(samples.subarray(0, length));
    return output;
  }
  const ratio = DSP_RATE / sampleRate;
  const last = samples.length - 1;
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    if (index > last) break;
    const t = position - index;
    // The four neighbours; past either end of the signal they are silent
    const a = index >= 1 ? samples[index - 1] : 0;
    const b = samples[index];
    const c = index + 1 <= last ? samples[index + 1] : 0;
    const d = index + 2 <= last ? samples[index + 2] : 0;
    output[i] = b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
  }
  return output;
}
