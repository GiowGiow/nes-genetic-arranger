// @ts-check
/**
 * From heard notes to a MIDI file (spec 007, audio import).
 *
 * A transcription model (Basic Pitch, in `vendor/basic-pitch/`, run by `ui/audio-import.js`) turns
 * the samples of a recording into notes: a pitch, a start, a length and a loudness each. This
 * module makes those notes something the arranger can read:
 *
 * - `cleanNotes` drops what is too short or too weak to be a note;
 * - `trackMelodyFrames` follows the strongest line in the singing register through the model's
 *   frame-by-frame activations (a Viterbi path), which finds a voice in a band better than the
 *   highest note does; `splitMelody` is the fallback, the skyline of the notes (the highest
 *   sounding note at every moment). Whatever is not the melody is the accompaniment, so the
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

/** Frames the model gives per second of audio. */
export const FRAMES_PER_SECOND = MODEL_RATE / 256;

/** The register the melody tracker listens in (MIDI pitches A2 to E5): where a voice sings. */
const SINGING_RANGE = /** @type {const} */ ([45, 76]);

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
 * A note found by `trackMelodyFrames`, in the model's frames.
 * @typedef {object} TrackedNote
 * @property {number} pitchMidi
 * @property {number} amplitude the mean activation along the note, from 0 to 1.
 * @property {number} startFrame
 * @property {number} durationFrames
 */

/**
 * Follow the melody through the model's note activations.
 *
 * Every frame is in one of the keys of the singing register or in silence; the path that adds up
 * the most activation, with a cost for leaps and for starting or stopping, is found with the
 * Viterbi algorithm. A run of one key is a note. This picks the line that is strongest and
 * steadiest in the register, a voice or a solo, and does not jump to a horn above it or to the
 * bass below it, as the skyline of the notes does. Notes shorter than a tenth of a second are
 * dropped.
 *
 * @param {number[][]} frames activations from 0 to 1, one row per frame, one column per piano key
 *   from A0 (MIDI 21), as the model gives them
 * @param {{low?: number, high?: number, silence?: number, leap?: number, onsets?: number[][] | null}} [options]
 *   the register (MIDI pitches, default 45 to 76), the activation below which silence wins
 *   (default 0.1), the cost of a leap per two semitones (default 0.6), and the model's onset
 *   activations, which start a new note where the same pitch is struck again
 * @returns {TrackedNote[]} in time order
 * @example
 * trackMelodyFrames(frames).map((note) => note.pitchMidi); // [60, 64, 62]
 */
export function trackMelodyFrames(
  frames,
  { low = SINGING_RANGE[0], high = SINGING_RANGE[1], silence = 0.1, leap = 0.6, onsets = null, minSeconds = 0.1, onsetGap = 6 } = {},
) {
  const keys = high - low + 1;
  const silent = keys; // the last state
  const states = keys + 1;
  const total = frames.length;
  if (total === 0) return [];
  const silenceScore = Math.log(silence);
  /** @param {number} from @param {number} to */
  const move = (from, to) => {
    if (from === to) return 0;
    if (from === silent || to === silent) return -1;
    return (-leap * Math.min(Math.abs(from - to), 12)) / 2;
  };
  let before = new Float64Array(states).fill(-1e9);
  before[silent] = 0;
  const came = Array.from({ length: total }, () => new Int16Array(states));
  for (let frame = 0; frame < total; frame++) {
    const now = new Float64Array(states);
    for (let to = 0; to < states; to++) {
      let best = -Infinity;
      let from = 0;
      for (let candidate = 0; candidate < states; candidate++) {
        const value = before[candidate] + move(candidate, to);
        if (value > best) {
          best = value;
          from = candidate;
        }
      }
      now[to] = best + (to === silent ? silenceScore : Math.log(Math.max(1e-4, frames[frame][low + to - 21])));
      came[frame][to] = from;
    }
    before = now;
  }
  let state = before.indexOf(Math.max(...before));
  const path = new Int16Array(total);
  for (let frame = total - 1; frame >= 0; frame--) {
    path[frame] = state;
    state = came[frame][state];
  }
  /**
   * A run of one pitch, cut where the model hears the pitch struck again: at a frame whose onset
   * activation is 0.5 or more, is the highest within two frames either side, and is at least 70 ms
   * after the last cut.
   *
   * @param {number} first
   * @param {number} end
   * @param {number} pitch
   * @returns {Array<[number, number]>} [first frame, end frame] of each note
   */
  const splitAtOnsets = (first, end, pitch) => {
    if (!onsets) return [[first, end]];
    /** @type {Array<[number, number]>} */
    const parts = [];
    let from = first;
    for (let frame = first + onsetGap; frame < end - 3; frame++) {
      const here = onsets[frame]?.[pitch - 21] ?? 0;
      if (here < 0.5 || frame - from < onsetGap) continue;
      let peak = true;
      for (let near = frame - 2; near <= frame + 2; near++) if ((onsets[near]?.[pitch - 21] ?? 0) > here) peak = false;
      if (!peak) continue;
      parts.push([from, frame]);
      from = frame;
    }
    parts.push([from, end]);
    return parts;
  };
  /** @type {TrackedNote[]} */
  const notes = [];
  let start = 0;
  for (let frame = 1; frame <= total; frame++) {
    if (frame < total && path[frame] === path[start]) continue;
    if (path[start] !== silent) {
      for (const [first, end] of splitAtOnsets(start, frame, low + path[start])) {
        const length = end - first;
        if (length / FRAMES_PER_SECOND < minSeconds) continue;
        let sum = 0;
        for (let at = first; at < end; at++) sum += frames[at][low + path[start] - 21];
        notes.push({ pitchMidi: low + path[start], amplitude: sum / length, startFrame: first, durationFrames: length });
      }
    }
    start = frame;
  }
  return notes;
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
 * Split the notes around a melody that was found elsewhere: a note is the melody's when a melody
 * note of the same pitch covers most of it; the others are the accompaniment.
 *
 * @param {HeardNote[]} notes
 * @param {HeardNote[]} melody
 * @returns {{melody: HeardNote[], rest: HeardNote[]}}
 */
function withMelody(notes, melody) {
  const rest = notes.filter(
    (note) =>
      !melody.some((line) => {
        const overlap =
          Math.min(line.startTimeSeconds + line.durationSeconds, note.startTimeSeconds + note.durationSeconds) -
          Math.max(line.startTimeSeconds, note.startTimeSeconds);
        return line.pitchMidi === note.pitchMidi && overlap > 0.5 * note.durationSeconds;
      }),
  );
  return { melody: [...melody].sort((a, b) => a.startTimeSeconds - b.startTimeSeconds), rest };
}

/**
 * Write the notes as a MIDI file the arranger can read: a "Melody" track (the skyline) and an
 * "Accompaniment" track (the rest), at the estimated tempo, in 4/4, with the first beat moved to
 * the start of the file.
 *
 * @param {HeardNote[]} notes straight from the model; they are cleaned here
 * @param {{melody?: HeardNote[] | null}} [options] `melody`: the melody already found (for example
 *   by `trackMelodyFrames`); the notes it does not hold are the accompaniment. Without it the
 *   melody is the skyline of the notes.
 * @returns {{bytes: Uint8Array, bpm: number, melodyCount: number, restCount: number}}
 * @example
 * notesToMidi(notes).bpm; // 118.5
 */
export function notesToMidi(notes, { melody: found = null } = {}) {
  const kept = cleanNotes(notes);
  const { melody, rest } = found ? withMelody(kept, found) : splitMelody(kept);
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
