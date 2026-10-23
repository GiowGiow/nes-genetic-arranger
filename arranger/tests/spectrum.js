// @ts-check
// A small spectrum analyser for the audio tests (not a test itself: node --test only runs files
// named `*.test.js`).
//
// The pack tests make claims about sound that are claims about frequencies: "the top octave is
// quieter", "more modulation gives more harmonics", "a pitch is 440 Hz". `powerSpectrum` averages
// the Hann-windowed FFT of many frames of a signal (Welch's method), which is steady enough to
// compare two renders of the same music.

/**
 * In-place iterative radix-2 FFT.
 * @param {Float64Array} real
 * @param {Float64Array} imaginary
 */
function fft(real, imaginary) {
  const size = real.length;
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    for (let start = 0; start < size; start += length) {
      for (let k = 0; k < length / 2; k++) {
        const cosine = Math.cos(angle * k);
        const sine = Math.sin(angle * k);
        const a = start + k;
        const b = a + length / 2;
        const re = real[b] * cosine - imaginary[b] * sine;
        const im = real[b] * sine + imaginary[b] * cosine;
        real[b] = real[a] - re;
        imaginary[b] = imaginary[a] - im;
        real[a] += re;
        imaginary[a] += im;
      }
    }
  }
}

/**
 * The average power of each frequency bin over the whole signal (Welch's method, 50% overlap).
 * @param {ArrayLike<number>} samples
 * @param {number} [frameSize] a power of two (default 4096)
 * @returns {Float64Array} `frameSize / 2` bins; bin k is at k × sampleRate / frameSize Hz
 */
export function powerSpectrum(samples, frameSize = 4096) {
  const power = new Float64Array(frameSize / 2);
  const real = new Float64Array(frameSize);
  const imaginary = new Float64Array(frameSize);
  const window = Float64Array.from({ length: frameSize }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frameSize));
  let frames = 0;
  for (let start = 0; start + frameSize <= samples.length; start += frameSize / 2) {
    for (let i = 0; i < frameSize; i++) {
      real[i] = samples[start + i] * window[i];
      imaginary[i] = 0;
    }
    fft(real, imaginary);
    for (let k = 0; k < frameSize / 2; k++) power[k] += real[k] ** 2 + imaginary[k] ** 2;
    frames += 1;
  }
  if (frames > 0) for (let k = 0; k < power.length; k++) power[k] /= frames;
  return power;
}

/**
 * The power of a signal between two frequencies, in dB relative to a full-scale sine's power
 * (so that two renders at the same peak can be compared band by band).
 * @param {ArrayLike<number>} samples
 * @param {number} sampleRate
 * @param {number} lowHz
 * @param {number} highHz
 * @param {number} [frameSize] FFT size, a power of two; use a smaller one (1024) for sounds shorter than 0.1 s
 * @returns {number} dB
 */
export function bandLevelDb(samples, sampleRate, lowHz, highHz, frameSize = 4096) {
  const power = powerSpectrum(samples, frameSize);
  // Parseval: a full-scale sine under a Hann window puts 3 N² / 32 of power into the N/2 bins
  const sineBins = (3 * frameSize ** 2) / 32;
  let band = 0;
  power.forEach((value, k) => {
    const hz = (k * sampleRate) / frameSize;
    if (hz >= lowHz && hz < highHz) band += value;
  });
  return 10 * Math.log10(Math.max(band, 1e-30) / sineBins);
}

/**
 * The share of a signal's power that lies between two frequencies, in dB relative to its whole
 * power.
 * @param {ArrayLike<number>} samples
 * @param {number} sampleRate
 * @param {number} lowHz
 * @param {number} highHz
 * @returns {number} dB, 0 when the band holds everything and negative otherwise
 */
export function bandShareDb(samples, sampleRate, lowHz, highHz) {
  const frameSize = 4096;
  const power = powerSpectrum(samples, frameSize);
  let band = 0;
  let total = 0;
  power.forEach((value, k) => {
    const hz = (k * sampleRate) / frameSize;
    total += value;
    if (hz >= lowHz && hz < highHz) band += value;
  });
  return 10 * Math.log10(Math.max(band, 1e-30) / Math.max(total, 1e-30));
}

/**
 * The frequency of the strongest peak of a signal, refined by parabolic interpolation.
 * @param {ArrayLike<number>} samples
 * @param {number} sampleRate
 * @returns {number} Hz
 */
export function peakFrequency(samples, sampleRate) {
  const frameSize = 16384;
  const power = powerSpectrum(samples, frameSize);
  let best = 1;
  for (let k = 1; k < power.length - 1; k++) if (power[k] > power[best]) best = k;
  const [a, b, c] = [Math.log(power[best - 1] + 1e-30), Math.log(power[best] + 1e-30), Math.log(power[best + 1] + 1e-30)];
  const offset = (0.5 * (a - c)) / (a - 2 * b + c);
  return ((best + offset) * sampleRate) / frameSize;
}
