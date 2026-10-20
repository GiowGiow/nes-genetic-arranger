// @ts-check
/**
 * Audio import (spec 007): turn a recording into a MIDI file, on the visitor's device.
 *
 * The browser decodes the file (MP3, WAV, M4A, OGG, FLAC…) and resamples it to the 22,050 Hz mono
 * that Basic Pitch listens at; Basic Pitch (vendored in `vendor/basic-pitch/`, loaded only now)
 * finds the notes; `core/audio-to-midi.js` turns them into a MIDI file with a melody track and an
 * accompaniment track. The page then reads that file like any other MIDI file. Nothing is sent
 * anywhere. It hears one voice or instrument well and a full mix roughly.
 *
 * A YouTube video cannot be reached this way: a page cannot read another site's media, so a video's
 * audio has to be saved by the visitor first and opened here as a file.
 */

import { MODEL_RATE, mixToMono, notesToMidi, trackMelodyFrames } from "../core/audio-to-midi.js";

/** File name extensions that are taken as audio. */
export const AUDIO_EXTENSIONS = Object.freeze(["mp3", "wav", "m4a", "aac", "ogg", "oga", "opus", "flac", "webm"]);

/** The most audio that is listened to, in seconds (the arranger takes at most 256 bars). */
export const MAX_SECONDS = 300;

const VENDOR = new URL("../../vendor/basic-pitch/", import.meta.url).href;

/**
 * Whether a file name is an audio file's.
 *
 * @param {string} name
 * @returns {boolean}
 * @example
 * isAudioName("Song.MP3"); // true
 * isAudioName("song.mid"); // false
 */
export function isAudioName(name) {
  const extension = /\.([^.]+)$/.exec(name)?.[1].toLowerCase() ?? "";
  return AUDIO_EXTENSIONS.includes(extension);
}

/**
 * Listen to an audio file and write what it plays as a MIDI file.
 *
 * @param {File} file an audio file
 * @param {{onProgress?: (text: string) => void}} [options] `onProgress` gets a short sentence at
 *   each stage
 * @returns {Promise<{file: File, bpm: number, seconds: number, trimmed: boolean}>} the MIDI file
 *   (named after the audio's), the tempo found, how much audio was heard, and whether the audio
 *   was cut at `MAX_SECONDS`
 * @throws {Error} with a sentence for the visitor when the file cannot be decoded or no note is heard
 * @example
 * const { file: midi } = await transcribeAudioFile(audioFile, { onProgress: showStatus });
 */
export async function transcribeAudioFile(file, { onProgress = () => {} } = {}) {
  onProgress(`Decoding ${file.name}…`);
  let decoded;
  try {
    // An offline context at the model's rate: decodeAudioData resamples to it.
    decoded = await new OfflineAudioContext(1, 1, MODEL_RATE).decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error(`${file.name} is not an audio file this browser can read.`);
  }
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
  let samples = mixToMono(channels);
  const trimmed = samples.length > MAX_SECONDS * MODEL_RATE;
  if (trimmed) samples = samples.subarray(0, MAX_SECONDS * MODEL_RATE);

  onProgress("Loading the transcription model…");
  const { BasicPitch, outputToNotesPoly, noteFramesToTime, tf } = await import(`${VENDOR}basic-pitch.js`);
  try {
    await tf.setBackend("webgl");
  } catch {
    await tf.setBackend("cpu");
  }
  await tf.ready();

  /** @type {number[][]} */
  const frames = [];
  /** @type {number[][]} */
  const onsets = [];
  const model = new BasicPitch(tf.loadGraphModel(`${VENDOR}model.json`));
  await model.evaluateModel(
    samples,
    (/** @type {number[][]} */ batchFrames, /** @type {number[][]} */ batchOnsets) => {
      frames.push(...batchFrames);
      onsets.push(...batchOnsets);
    },
    (/** @type {number} */ done) => onProgress(`Listening… ${Math.round(done * 100)}%`),
  );
  onProgress("Writing the notes…");
  const notes = noteFramesToTime(outputToNotesPoly(frames, onsets, 0.5, 0.3, 5, true, null, null, true));
  // The melody is the strongest line in the singing register; if that finds almost nothing (a tune
  // above the voice's range, say), the highest sounding note is the melody instead.
  const tracked = noteFramesToTime(trackMelodyFrames(frames, { onsets }));
  const { bytes, bpm, melodyCount } = notesToMidi(notes, { melody: tracked.length >= 3 ? tracked : null });
  if (melodyCount === 0) throw new Error(`No notes were heard in ${file.name}.`);
  const name = `${file.name.replace(/\.[^.]*$/, "")}.mid`;
  return { file: new File([bytes], name, { type: "audio/midi" }), bpm, seconds: samples.length / MODEL_RATE, trimmed };
}
