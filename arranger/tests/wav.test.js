// @ts-check
// Tests for audio/wav.js, which writes the "Audio (WAV)" download (spec 005, research R3).
//
// A WAV file is a 44-byte RIFF header followed by the samples. The tests read the header back
// field by field, as a media player does, and check how samples become 16-bit integers: clamped
// to [-1, 1], scaled by 32,767 and rounded, little-endian.

import { test } from "node:test";
import assert from "node:assert/strict";

import { encodeWav } from "../src/audio/wav.js";

/**
 * The four ASCII letters at `offset`.
 * @param {Uint8Array} bytes
 * @param {number} offset
 */
const tagAt = (bytes, offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));

/** @param {Uint8Array} bytes */
const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

test("the header says RIFF/WAVE, PCM, mono, 16 bits, the sample rate and the sizes", () => {
  const bytes = encodeWav(new Float32Array(10), 48000);
  const view = viewOf(bytes);

  assert.ok(bytes instanceof Uint8Array);
  assert.equal(tagAt(bytes, 0), "RIFF");
  assert.equal(view.getUint32(4, true), 36 + 20, "RIFF size: the file minus 8 bytes");
  assert.equal(tagAt(bytes, 8), "WAVE");
  assert.equal(tagAt(bytes, 12), "fmt ");
  assert.equal(view.getUint32(16, true), 16, "fmt chunk size");
  assert.equal(view.getUint16(20, true), 1, "format: PCM");
  assert.equal(view.getUint16(22, true), 1, "channels: mono");
  assert.equal(view.getUint32(24, true), 48000, "sample rate");
  assert.equal(view.getUint32(28, true), 96000, "byte rate: rate × 2 bytes");
  assert.equal(view.getUint16(32, true), 2, "block align: 2 bytes per frame");
  assert.equal(view.getUint16(34, true), 16, "bits per sample");
  assert.equal(tagAt(bytes, 36), "data");
  assert.equal(view.getUint32(40, true), 20, "data size: 2 bytes per sample");
});

test("the file is 44 header bytes plus 2 bytes per sample", () => {
  for (const n of [0, 1, 7, 44100]) {
    assert.equal(encodeWav(new Float32Array(n), 44100).length, 44 + 2 * n, `${n} samples`);
  }
});

test("samples are clamped to [-1, 1], scaled by 32,767 and rounded, little-endian", () => {
  const samples = Float32Array.of(0, 1, -1, 1.5, -2, 0.5, -0.5, 0.25, 1e-6);
  const bytes = encodeWav(samples, 44100);
  const view = viewOf(bytes);
  const written = Array.from(samples, (_, i) => view.getInt16(44 + 2 * i, true));

  // 0.5 × 32,767 = 16,383.5 rounds up to 16,384; -16,383.5 rounds up to -16,383 (Math.round).
  assert.deepEqual(written, [0, 32767, -32767, 32767, -32767, 16384, -16383, 8192, 0]);
  assert.deepEqual([bytes[46], bytes[47]], [0xff, 0x7f], "32,767 is stored low byte first");
});
