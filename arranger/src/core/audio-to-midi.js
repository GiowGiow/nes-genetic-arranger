// @ts-check
/**
 * From heard notes to a MIDI file (spec 007, audio import).
 *
 * A transcription model (Basic Pitch, in `vendor/basic-pitch/`, run by `ui/audio-import.js`) turns
 * the samples of a recording into notes: a pitch, a start, a length and a loudness each. This
 * module makes those notes something the arranger can read:
 *
 * - `cleanNotes` drops what is too short or too weak to be a note;
 * - `splitMelody` takes the highest sounding note at every moment as the melody (the skyline of the
 *   notes, as the MIDI track table's skyline) and leaves the rest as the accompaniment, so the
 *   lead-sheet reader finds a melody track and chords from the other one;
 * - `estimateTempo` finds the beat that the onsets fall on, and where the first beat is, because a
 *   recording has no tempo map and the reader quantizes to the beat;
 * - `notesToMidi` writes a MIDI file with a "Melody" track and an "Accompaniment" track, in 4/4,
 *   with the beat grid at the start of the file.
 *
 * All of it is plain numbers, so it is tested without audio.
 */

import { writeMidiFile } from "./midi-file.js";

/**
 * A note the model heard, as Basic Pitch reports it.
 * @typedef {object} HeardNote
 * @property {number} pitchMidi MIDI pitch (0–127).
 * @property {number} amplitude loudness from 0 to 1.
 * @property {number} startTimeSeconds
 * @property {number} durationSeconds
 */

/** The sample rate the transcription model listens at. */
export const MODEL_RATE = 22050;

/** Shortest note kept, in seconds (a blip is the model's doubt, not a note). */
const MIN_SECONDS = 0.08;

/** Weakest note kept (amplitude from 0 to 1). */
const MIN_AMPLITUDE = 0.1;

/** Notes below this pitch (G3) are the bass: they never carry the melody. */
const MELODY_FLOOR = 55;

/** Two onsets closer than this (seconds) are one onset: the higher note wins the melody. */
const SAME_ONSET = 0.03;

/** A lower note that starts after this share of the melody note has gone by is its successor. */
const HANDOVER = 0.8;

/** The tempi searched, in beats per minute: slower and faster ones are found as a half or a double. */
const TEMPO_RANGE = /** @type {const} */ ([65, 150]);

/** The tempo used when the notes say nothing about one. */
const DEFAULT_BPM = 120;

/**
 * Mix the channels of a recording into one, by their mean.
 *
 * @param {Float32Array[]} channels one array of samples per channel, all of the same length
 * @returns {Float32Array} the mono samples; the only channel itself when there is one
 * @example
 * mixToMono([Float32Array.of(1, 0), Float32Array.of(0, 0)]); // Float32Array [0.5, 0]
 */
export function mixToMono(channels) {
  if (channels.length === 1) return channels[0];
  const mixed = new Float32Array(channels[0].length);
  for (const channel of channels) {
    for (let i = 0; i < mixed.length; i++) mixed[i] += channel[i] / channels.length;
  }
  return mixed;
}

/**
 * Keep the notes that are long and loud enough to be played, in time order.
 *
 * @param {HeardNote[]} notes
 * @param {{minSeconds?: number, minAmplitude?: number}} [limits]
 * @returns {HeardNote[]} a new list
 * @example
 * cleanNotes([{ pitchMidi: 60, amplitude: 0.5, startTimeSeconds: 0, durationSeconds: 0.01 }]); // []
 */
export function cleanNotes(notes, { minSeconds = MIN_SECONDS, minAmplitude = MIN_AMPLITUDE } = {}) {
  return notes
    .filter((note) => note.durationSeconds >= minSeconds && note.amplitude >= minAmplitude)
    .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds || b.pitchMidi - a.pitchMidi);
}

/**
 * Split the notes into a melody, one note at a time and always the highest that sounds, and the
 * rest. A bass note (below G3) is never the melody. A higher note that starts while the melody
 * still sounds takes it over and cuts the melody note short; a lower one does too when it starts
 * in the last fifth of the melody note, as that note is dying away.
 *
 * @param {HeardNote[]} notes
 * @returns {{melody: HeardNote[], rest: HeardNote[]}} both in time order; every note is in one of them
 * @example
 * splitMelody([{ pitchMidi: 76, amplitude: 0.6, startTimeSeconds: 0, durationSeconds: 1 },
 *   { pitchMidi: 60, amplitude: 0.6, startTimeSeconds: 0, durationSeconds: 1 }]).rest[0].pitchMidi; // 60
 */
export function splitMelody(notes) {
  const sorted = [...notes].sort((a, b) => a.startTimeSeconds - b.startTimeSeconds || b.pitchMidi - a.pitchMidi);
  /** @type {HeardNote[]} */
  const melody = [];
  /** @type {HeardNote[]} */
  const rest = [];
  for (const note of sorted) {
    if (note.pitchMidi < MELODY_FLOOR) {
      rest.push(note);
      continue;
    }
    const last = melody.at(-1);
    const lastEnd = last ? last.startTimeSeconds + last.durationSeconds : -Infinity;
    if (!last || note.startTimeSeconds >= lastEnd - 1e-9) {
      melody.push({ ...note });
    } else if (note.pitchMidi > last.pitchMidi) {
      const heldFor = note.startTimeSeconds - last.startTimeSeconds;
      if (heldFor < SAME_ONSET) {
        rest.push(last);
        melody[melody.length - 1] = { ...note };
      } else {
        melody[melody.length - 1] = { ...last, durationSeconds: heldFor };
        melody.push({ ...note });
      }
    } else if (note.startTimeSeconds >= last.startTimeSeconds + HANDOVER * last.durationSeconds) {
      // A lower note that begins as the melody note dies away is the next note of the melody
      // (the model lets a note ring a little into the next one), not a note under it.
      melody[melody.length - 1] = { ...last, durationSeconds: note.startTimeSeconds - last.startTimeSeconds };
      melody.push({ ...note });
    } else {
      rest.push(note);
    }
  }
  rest.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds || a.pitchMidi - b.pitchMidi);
  return { melody, rest };
}

/**
 * The beat the note onsets fall on, and where it starts.
 *
 * Every tempo from 65 to 150 beats per minute is tried; for each, the onsets are placed on a circle
 * by their time within a beat, and the tempo whose onsets bunch up the most (by loudness) wins.
 * Its phase is where the beats fall. A half or a double of the true tempo can win; the range keeps
 * the answer near a walking pace.
 *
 * @param {HeardNote[]} notes
 * @returns {{bpm: number, offsetSeconds: number}} the tempo, and the time of the first beat from
 *   the start of the recording, between 0 and one beat; 120 and 0 when there are too few notes
 * @example
 * estimateTempo(onsetsEveryHalfSecondFrom(0.1)); // { bpm: 120, offsetSeconds: 0.1 }
 */
export function estimateTempo(notes) {
  if (notes.length < 4) return { bpm: DEFAULT_BPM, offsetSeconds: 0 };
  let best = { score: -1, bpm: DEFAULT_BPM, phase: 0 };
  for (let bpm = TEMPO_RANGE[0]; bpm < TEMPO_RANGE[1]; bpm += 0.5) {
    const period = 60 / bpm;
    let real = 0;
    let imaginary = 0;
    let total = 0;
    for (const note of notes) {
      const weight = Math.max(0.1, note.amplitude);
      const angle = (2 * Math.PI * note.startTimeSeconds) / period;
      real += weight * Math.cos(angle);
      imaginary += weight * Math.sin(angle);
      total += weight;
    }
    const score = Math.hypot(real, imaginary) / total;
    if (score > best.score + 1e-9) best = { score, bpm, phase: Math.atan2(imaginary, real) };
  }
  const period = 60 / best.bpm;
  const turns = best.phase / (2 * Math.PI);
  return { bpm: best.bpm, offsetSeconds: (turns - Math.floor(turns)) * period };
}

/**
 * Write the notes as a MIDI file the arranger can read: a "Melody" track (the skyline) and an
 * "Accompaniment" track (the rest), at the estimated tempo, in 4/4, with the first beat moved to
 * the start of the file.
 *
 * @param {HeardNote[]} notes straight from the model; they are cleaned here
 * @returns {{bytes: Uint8Array, bpm: number, melodyCount: number, restCount: number}}
 * @example
 * notesToMidi(notes).bpm; // 118.5
 */
export function notesToMidi(notes) {
  const kept = cleanNotes(notes);
  const { melody, rest } = splitMelody(kept);
  const { bpm, offsetSeconds } = estimateTempo(kept);
  const period = 60 / bpm;
  const first = kept.length > 0 ? kept[0].startTimeSeconds : 0;
  // Move every note so that a beat of the grid falls on 0, without any start going below 0.
  const shift = Math.ceil((offsetSeconds - first) / period - 1e-9) * period - offsetSeconds;
  /** @param {HeardNote[]} list */
  const asTrackNotes = (list) =>
    list.map((note) => ({
      start: note.startTimeSeconds + shift,
      end: note.startTimeSeconds + note.durationSeconds + shift,
      pitch: Math.max(0, Math.min(127, Math.round(note.pitchMidi))),
      velocity: Math.max(1, Math.min(127, Math.round(40 + 80 * note.amplitude))),
    }));
  const bytes = writeMidiFile({
    tempoBpm: bpm,
    tracks: [
      { name: "Melody", channel: 0, program: 73, notes: asTrackNotes(melody) },
      { name: "Accompaniment", channel: 1, program: 0, notes: asTrackNotes(rest) },
    ],
  });
  return { bytes, bpm: Math.round(bpm * 10) / 10, melodyCount: melody.length, restCount: rest.length };
}
