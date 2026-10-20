// @ts-check
// Write samples as a WAV file, for the "Audio (WAV)" download (spec 005, research R3).
//
// WAV is the simplest common audio file: a short header that says how to read the numbers,
// then the samples themselves, uncompressed (PCM, pulse-code modulation). The header follows
// the RIFF layout: chunks, each a four-letter tag and a size, all in little-endian byte order.
//
//   bytes  0-11  "RIFF", the size of the rest of the file, "WAVE"
//   bytes 12-35  "fmt " chunk: PCM, 1 channel, the sample rate, 16 bits per sample
//   bytes 36-43  "data" chunk header: the size of the samples in bytes
//   bytes 44-    the samples, 2 bytes each
//
// A sample in [-1, 1] becomes a 16-bit integer: it is clamped to [-1, 1], multiplied by 32,767
// and rounded, so +1 and -1 map to the same distance from 0. The page's renders peak at
// -3 dBFS, so clamping only guards against a value that slipped past the scale.

// Bytes before the samples: the RIFF header (12), the fmt chunk (24) and the data header (8).
const HEADER_BYTES = 44;

// Mono, 16 bits per sample.
const CHANNEL_COUNT = 1;
const BYTES_PER_SAMPLE = 2;

/**
 * Encode mono samples as a 16-bit PCM WAV file.
 * @param {ArrayLike<number>} samples the sound, in [-1, 1] (values outside are clamped)
 * @param {number} sampleRate samples per second, for example the AudioContext's
 * @returns {Uint8Array} the file's bytes: a 44-byte header, then 2 bytes per sample
 * @example
 * const wav = encodeWav(Float32Array.of(0, 0.5, -1), 44100);
 * wav.length; // 50: 44 + 2 × 3
 * String.fromCharCode(...wav.subarray(0, 4)); // "RIFF"
 */
export function encodeWav(samples, sampleRate) {
  const dataBytes = samples.length * BYTES_PER_SAMPLE;
  const bytes = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  const writeTag = (/** @type {number} */ offset, /** @type {string} */ tag) => {
    for (let i = 0; i < 4; i++) view.setUint8(offset + i, tag.charCodeAt(i));
  };

  writeTag(0, "RIFF");
  view.setUint32(4, HEADER_BYTES - 8 + dataBytes, true); // everything after this field
  writeTag(8, "WAVE");
  writeTag(12, "fmt ");
  view.setUint32(16, 16, true); // the size of the fmt fields below
  view.setUint16(20, 1, true); // format 1: PCM
  view.setUint16(22, CHANNEL_COUNT, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * CHANNEL_COUNT * BYTES_PER_SAMPLE, true); // bytes per second
  view.setUint16(32, CHANNEL_COUNT * BYTES_PER_SAMPLE, true); // bytes per frame
  view.setUint16(34, 8 * BYTES_PER_SAMPLE, true); // bits per sample
  writeTag(36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(HEADER_BYTES + BYTES_PER_SAMPLE * i, Math.round(clamped * 32767), true);
  }
  return bytes;
}
