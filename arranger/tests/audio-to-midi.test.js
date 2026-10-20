// @ts-check
// Tests for core/audio-to-midi.js: the notes that a transcription model heard become a MIDI file
// that the arranger reads like any other (melody track first, the rest as the accompaniment).
//
// The model itself (Basic Pitch, vendored in vendor/basic-pitch/) is checked in
// tests/basic-pitch.test.js; here the notes are made up.

import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanNotes, estimateTempo, mixToMono, notesToMidi, splitMelody } from "../src/core/audio-to-midi.js";
import { readMidiFile } from "../src/core/midi-file.js";

/**
 * @param {number} pitchMidi
 * @param {number} startTimeSeconds
 * @param {number} durationSeconds
 * @param {number} [amplitude]
 */
const heard = (pitchMidi, startTimeSeconds, durationSeconds, amplitude = 0.6) => ({
  pitchMidi,
  startTimeSeconds,
  durationSeconds,
  amplitude,
});

test("channels are mixed to one by their mean, and one channel passes through", () => {
  const mixed = mixToMono([Float32Array.of(1, 0.5, -1), Float32Array.of(0, 0.5, 1)]);
  assert.deepEqual([...mixed], [0.5, 0.5, 0]);
  const only = Float32Array.of(0.25, -0.25);
  assert.deepEqual([...mixToMono([only])], [0.25, -0.25]);
});

test("notes that are too short or too weak to be played are dropped, the others are kept in time order", () => {
  const notes = [
    heard(72, 1, 0.5),
    heard(60, 0, 0.5),
    heard(81, 0.1, 0.05), // a blip
    heard(64, 2, 0.5, 0.02), // inaudible
  ];
  assert.deepEqual(
    cleanNotes(notes).map((note) => note.pitchMidi),
    [60, 72],
  );
});

test("the melody is the highest sounding note; bass notes and lower notes of a chord stay with the accompaniment", () => {
  const notes = [
    heard(36, 0, 2), // bass
    heard(60, 0, 1), // chord under the melody
    heard(64, 0, 1),
    heard(76, 0, 0.5), // melody
    heard(79, 0.5, 0.5),
    heard(77, 1, 0.5),
  ];
  const { melody, rest } = splitMelody(notes);
  assert.deepEqual(
    melody.map((note) => note.pitchMidi),
    [76, 79, 77],
  );
  assert.deepEqual(
    rest.map((note) => note.pitchMidi).sort((a, b) => a - b),
    [36, 60, 64],
  );
});

test("a higher note that starts while the melody still sounds takes over, and the melody never overlaps itself", () => {
  const { melody } = splitMelody([heard(70, 0, 2), heard(74, 1, 1)]);
  assert.deepEqual(
    melody.map((note) => [note.pitchMidi, note.startTimeSeconds]),
    [[70, 0], [74, 1]],
  );
  assert.ok(melody[0].startTimeSeconds + melody[0].durationSeconds <= melody[1].startTimeSeconds + 1e-9);
});

test("a lower note that starts as the melody note dies away continues the melody; one that starts under a held note stays with the accompaniment", () => {
  const { melody, rest } = splitMelody([
    heard(69, 3.0, 0.65), // rings on a little into the next note
    heard(67, 3.6, 1.2), // the next melody note, lower
    heard(76, 6, 3), // a held melody note
    heard(64, 7, 0.5), // an arpeggio note under it
  ]);
  assert.deepEqual(
    melody.map((note) => note.pitchMidi),
    [69, 67, 76],
  );
  assert.ok(melody[0].startTimeSeconds + melody[0].durationSeconds <= 3.6 + 1e-9);
  assert.deepEqual(
    rest.map((note) => note.pitchMidi),
    [64],
  );
});

test("the tempo is the beat that the note onsets fall on, and the grid starts at the first beat", () => {
  // 120 beats per minute: one onset every half second, from 0.1 s
  const regular = Array.from({ length: 24 }, (_, index) => heard(60 + (index % 5), 0.1 + index * 0.5, 0.2));
  const fast = estimateTempo(regular);
  assert.ok(Math.abs(fast.bpm - 120) < 1.5, `${fast.bpm}`);
  assert.ok(Math.abs(fast.offsetSeconds - 0.1) < 0.03, `${fast.offsetSeconds}`);

  // 90 beats per minute with onsets on beats and on some half beats, a little unsteady
  const beat = 60 / 90;
  const unsteady = [0, 1, 1.5, 2, 3, 3.5, 4, 5, 6, 6.5, 7, 8, 9, 9.5, 10, 11].map((position, index) =>
    heard(62, 0.3 + position * beat + (index % 3) * 0.008, 0.2),
  );
  const slow = estimateTempo(unsteady);
  assert.ok(Math.abs(slow.bpm - 90) < 2, `${slow.bpm}`);
});

test("a tune with no notes has no tempo to find and the default one is used", () => {
  assert.deepEqual(estimateTempo([]), { bpm: 120, offsetSeconds: 0 });
});

test("the notes become a MIDI file with a melody track and an accompaniment track on the beat grid", () => {
  const beat = 0.5;
  const notes = [
    heard(48, 0.2, 2), // bass
    ...Array.from({ length: 12 }, (_, index) => heard(72 + (index % 4), 0.2 + index * beat, 0.4)),
  ];
  const { bytes, bpm, melodyCount, restCount } = notesToMidi(notes);
  assert.ok(Math.abs(bpm - 120) < 1.5);
  assert.equal(melodyCount, 12);
  assert.equal(restCount, 1);

  const midi = readMidiFile(bytes);
  assert.equal(midi.resolution, 480);
  assert.deepEqual(
    midi.instruments.map((instrument) => instrument.name),
    ["Melody", "Accompaniment"],
  );
  const melody = midi.instruments[0].notes.slice().sort((a, b) => a.start - b.start);
  assert.deepEqual(
    melody.map((note) => note.pitch),
    notes.slice(1).map((note) => note.pitchMidi),
  );
  assert.ok(Math.abs(melody[0].start) < 0.02, "the first beat is at the start of the file");
  const step = melody[1].start - melody[0].start;
  assert.ok(Math.abs(step - 60 / bpm) < 0.03, "one onset per beat");
});

test("with no usable note the file holds no notes, so the page can say there is nothing to arrange", () => {
  const { bytes, melodyCount, restCount } = notesToMidi([]);
  assert.equal(melodyCount + restCount, 0);
  assert.equal(readMidiFile(bytes).instruments.length, 0);
});
