// @ts-check
// Tests for audio/note-schedule.js: when each note of a channel starts and stops.

import { test } from "node:test";
import assert from "node:assert/strict";

import { noteFrequency, sounding } from "../src/audio/note-schedule.js";

test("A4 (MIDI 69) is 440 Hz and an octave doubles the frequency", () => {
  assert.equal(noteFrequency(69), 440);
  assert.ok(Math.abs(noteFrequency(81) - 880) < 1e-9);
  assert.ok(Math.abs(noteFrequency(57) - 220) < 1e-9);
});

test("a channel plays one note at a time: a note stops when the next one starts", () => {
  const notes = [
    { pitch: 60, onset: 0, duration: 4, velocity: 100 },
    { pitch: 62, onset: 1, duration: 1, velocity: 100 },
  ];
  const timeline = sounding(notes, 0.5);
  assert.deepEqual(
    timeline.map(({ start, end }) => [start, end]),
    [
      [0, 0.5], // cut by the next note at beat 1
      [0.5, 1],
    ],
  );
});

test("at equal onsets the lowest note sounds last and survives the cut", () => {
  const notes = [
    { pitch: 42, onset: 0, duration: 1, velocity: 100 },
    { pitch: 36, onset: 0, duration: 1, velocity: 100 },
  ];
  const timeline = sounding(notes, 1);
  assert.deepEqual(timeline.map(({ note }) => note.pitch), [42, 36]);
  assert.equal(timeline[0].end, 0, "the hi-hat is cut at once");
  assert.equal(timeline[1].end, 1);
});
