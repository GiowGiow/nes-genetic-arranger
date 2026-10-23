// @ts-check
// The small filters that shape the sound packs.
//
// A filter keeps some frequencies and lowers others. Three are enough here, all working in
// place on a block of samples (a Float64Array, or a Float32Array) and all with a cutoff in Hz,
// the frequency where the level has fallen by 3 dB:
//
// - `lowpass`: a first-order (one-pole) low-pass. It lowers the highs by 6 dB per octave, a
//   gentle slope that warms a sound without dulling it, like the analog output stage of a chip.
// - `highpass`: a first-order high-pass. It lowers the lows by 6 dB per octave and blocks a
//   constant offset (0 Hz); the NES console has such filters on its output, because the audio
//   jack is AC-coupled.
// - `biquadLowpass`: a second-order (two-pole) Butterworth low-pass, 12 dB per octave, the
//   flattest response a second-order low-pass can have. The coefficients follow R. Bristow-
//   Johnson's "Audio EQ Cookbook". It is steeper than `lowpass`, which is what a small TV
//   speaker does to the highs of a chip.
//
// Each one is a recursive filter: every output sample is built from the input sample and the
// output samples before it, so the filter has a memory and needs a moment to settle. Filters are
// linear, so filtering each stem of a mix and adding them equals filtering the mix: the sound
// packs rely on that to filter their stems one by one.

/**
 * A one-pole low-pass filter, in place: it softens everything above `cutoffHz`.
 * @param {Float64Array | Float32Array} samples
 * @param {number} cutoffHz
 * @param {number} sampleRate
 * @returns {void}
 * @example
 * lowpass(samples, 6000, 44100); // 3 dB down at 6 kHz, 6 dB lower at each octave above
 */
export function lowpass(samples, cutoffHz, sampleRate) {
  const alpha = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  let state = 0;
  for (let i = 0; i < samples.length; i++) {
    state += alpha * (samples[i] - state);
    samples[i] = state;
  }
}

/**
 * A one-pole high-pass filter, in place: it lowers everything below `cutoffHz` and removes a
 * constant offset.
 * @param {Float64Array | Float32Array} samples
 * @param {number} cutoffHz
 * @param {number} sampleRate
 * @returns {void}
 * @example
 * highpass(samples, 90, 44100); // the NES console's first output filter
 */
export function highpass(samples, cutoffHz, sampleRate) {
  // y[n] = a (y[n-1] + x[n] - x[n-1]): a change passes, a constant fades with time constant 1/(2π fc)
  const feedback = Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  let previousInput = 0;
  let previousOutput = 0;
  for (let i = 0; i < samples.length; i++) {
    const input = samples[i];
    previousOutput = feedback * (previousOutput + input - previousInput);
    previousInput = input;
    samples[i] = previousOutput;
  }
}

/**
 * A second-order Butterworth low-pass filter, in place: 3 dB down at `cutoffHz` and 12 dB per
 * octave beyond it.
 * @param {Float64Array | Float32Array} samples
 * @param {number} cutoffHz
 * @param {number} sampleRate
 * @returns {void}
 * @example
 * biquadLowpass(samples, 6000, 44100); // a small speaker: little above 6 kHz
 */
export function biquadLowpass(samples, cutoffHz, sampleRate) {
  const omega = (2 * Math.PI * cutoffHz) / sampleRate;
  const alpha = Math.sin(omega) / (2 * Math.SQRT1_2); // Q = 1/√2 is the Butterworth value
  const cosine = Math.cos(omega);
  const a0 = 1 + alpha;
  const b0 = (1 - cosine) / 2 / a0;
  const b1 = (1 - cosine) / a0;
  const a1 = (-2 * cosine) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const input = samples[i];
    const output = b0 * input + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = input;
    y2 = y1;
    y1 = output;
    samples[i] = output;
  }
}
