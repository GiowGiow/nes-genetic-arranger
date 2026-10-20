// @ts-check
// The vendored Basic Pitch (vendor/basic-pitch/) hears a synthetic tune: two notes, A4 then C5, and
// the notes become a MIDI file whose melody track holds them in order.
//
// This runs the same bundle the page loads, on the CPU backend, with the model read from disk. The
// bundle takes its browser code path when `process` is not defined (tfjs would otherwise look for
// Node's `util` module, which the bundle leaves out), so `process` is hidden while it is imported.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { MODEL_RATE, notesToMidi } from "../src/core/audio-to-midi.js";
import { readMidiFile } from "../src/core/midi-file.js";
import { repoRoot } from "./helpers.js";

const vendor = join(repoRoot, "arranger/vendor/basic-pitch");

/** @returns {Promise<any>} the module's exports */
async function loadBundle() {
  const realProcess = globalThis.process;
  // @ts-ignore: hidden for the import only
  globalThis.process = undefined;
  try {
    return await import(join(vendor, "basic-pitch.js"));
  } finally {
    globalThis.process = realProcess;
  }
}

/** A model handler that reads the vendored model from disk instead of fetching it. */
function modelFromDisk() {
  const description = JSON.parse(readFileSync(join(vendor, "model.json"), "utf8"));
  const weights = readFileSync(join(vendor, "group1-shard1of1.bin"));
  return {
    load: async () => ({
      modelTopology: description.modelTopology,
      weightSpecs: description.weightsManifest[0].weights,
      weightData: weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength),
      format: description.format,
      generatedBy: description.generatedBy,
      convertedBy: description.convertedBy,
    }),
  };
}

test("the vendored model hears two notes and they become a melody track in order", { timeout: 120000 }, async () => {
  const { BasicPitch, outputToNotesPoly, noteFramesToTime, tf } = await loadBundle();
  await tf.setBackend("cpu");

  const seconds = 3;
  const samples = new Float32Array(MODEL_RATE * seconds);
  for (let i = 0; i < samples.length; i++) {
    const frequency = i < MODEL_RATE * 1.5 ? 440 : 523.25; // A4, then C5
    const phase = (2 * Math.PI * frequency * i) / MODEL_RATE;
    samples[i] = 0.5 * Math.sin(phase) + 0.2 * Math.sin(2 * phase);
  }

  /** @type {number[][]} */ const frames = [];
  /** @type {number[][]} */ const onsets = [];
  const model = new BasicPitch(tf.loadGraphModel(modelFromDisk()));
  await model.evaluateModel(
    samples,
    (/** @type {number[][]} */ f, /** @type {number[][]} */ o) => {
      frames.push(...f);
      onsets.push(...o);
    },
    () => {},
  );
  const notes = noteFramesToTime(outputToNotesPoly(frames, onsets, 0.5, 0.3, 5, true, null, null, true));
  const pitches = new Set(notes.map((/** @type {{pitchMidi: number}} */ note) => note.pitchMidi));
  assert.ok(pitches.has(69) && pitches.has(72), `heard ${[...pitches]}`);

  const { bytes, melodyCount } = notesToMidi(notes);
  assert.ok(melodyCount >= 2);
  const melody = readMidiFile(bytes)
    .instruments.find((instrument) => instrument.name === "Melody")
    ?.notes.slice()
    .sort((a, b) => a.start - b.start);
  assert.ok(melody, "a melody track");
  const order = melody.map((note) => note.pitch);
  assert.ok(order.indexOf(69) >= 0 && order.indexOf(72) > order.indexOf(69), `melody ${order}`);
});
