// @ts-check
// The render service: the sound of a run made from a message, so a Web Worker can do it.
//
// Rendering a sound pack is the heaviest thing the page asks of the CPU: the NES pack takes tens
// of milliseconds, the Super Nintendo and the Mega Drive packs a second or ten for a few minutes
// of music. On the page's own thread that freezes every click and animation until it ends. In a
// worker it costs the page nothing. This module is the worker's brain, free of any worker API: it
// takes a request message and returns a reply and the list of buffers to move (not copy) back to
// the page. `render-worker.js` wires it to `self`, and the tests call it directly.
//
// Messages:
// - `{type: "run", id, run, pack, sampleRate}`: render a run's four stems and its original,
//   matched in loudness (`renderRunAudio`). `run` has the notes: `id`, `arrangement`, `voices`,
//   `tempoBpm`, `durationBeats`.
// - `{type: "original", id, voices, tempoBpm, sampleRate, beats}`: render only the original, for a
//   song's preview.
// Replies: `{type: "done", id, ...}` or `{type: "error", id, message}`.
//
// The original's plain render does not depend on the sound pack, so the service keeps it for the
// run it rendered last: a change of pack renders the four stems again and reuses it. It never
// travels back to the page (it can be 30 MB), which keeps the page's memory to what it plays.

import { matchLoudness } from "./loudness.js";
import { renderVoices } from "./plain-synth.js";
import { renderRunAudio } from "./run-audio.js";

/**
 * Give an array a buffer of its own, so that moving the buffer moves nothing else.
 *
 * @param {ArrayLike<number>} samples any sample array
 * @returns {Float32Array}
 */
function owned(samples) {
  if (samples instanceof Float32Array && samples.byteOffset === 0 && samples.buffer.byteLength === samples.byteLength) {
    return samples;
  }
  return Float32Array.from(samples);
}

/**
 * Make a render service, with its own memory of the last run's plain original.
 *
 * @returns {{
 *   handle: (message: any) => {reply: any, transfer: ArrayBuffer[]},
 *   cachedRun: () => string | null,
 * }}
 * @example
 * const { reply, transfer } = service.handle({ type: "run", id: 1, run, pack: "snes", sampleRate: 44100 });
 * self.postMessage(reply, transfer); // the stems move to the page without a copy
 */
export function createRenderService() {
  /** @type {{runId: string, sampleRate: number, originalRaw: Float32Array} | null} */
  let cache = null;

  /** @param {any} message */
  function renderRun({ id, run, pack, sampleRate }) {
    const kept =
      cache && cache.runId === run.id && cache.sampleRate === sampleRate
        ? /** @type {any} */ ({ pack: "", sampleRate, originalRaw: cache.originalRaw })
        : null;
    const audio = renderRunAudio(run, pack, sampleRate, kept);
    if (audio.originalRaw) cache = { runId: run.id, sampleRate, originalRaw: audio.originalRaw };
    const stems = {
      P1: owned(audio.stems.P1),
      P2: owned(audio.stems.P2),
      TR: owned(audio.stems.TR),
      NO: owned(audio.stems.NO),
    };
    const originalSamples = owned(audio.originalSamples);
    // The matched original is a new array, but if it ever were the cached plain render, moving it would empty the cache.
    const safeOriginal = audio.originalRaw && originalSamples.buffer === audio.originalRaw.buffer ? originalSamples.slice() : originalSamples;
    const transfer = [stems.P1.buffer, stems.P2.buffer, stems.TR.buffer, stems.NO.buffer, safeOriginal.buffer];
    return {
      reply: {
        type: "done",
        id,
        audio: { pack: audio.pack, sampleRate: audio.sampleRate, stems, busScale: audio.busScale, originalRaw: null, originalSamples: safeOriginal },
      },
      transfer: /** @type {ArrayBuffer[]} */ (transfer),
    };
  }

  /** @param {any} message */
  function renderOriginal({ id, voices, tempoBpm, sampleRate, beats }) {
    const rendered = renderVoices(voices, tempoBpm, sampleRate, beats);
    const samples = owned(matchLoudness(rendered, rendered, sampleRate).a);
    return { reply: { type: "done", id, samples }, transfer: [/** @type {ArrayBuffer} */ (samples.buffer)] };
  }

  return {
    handle(message) {
      try {
        if (message.type === "run") return renderRun(message);
        if (message.type === "original") return renderOriginal(message);
        throw new RangeError(`unknown render message "${message.type}"`);
      } catch (error) {
        return { reply: { type: "error", id: message.id, message: error instanceof Error ? error.message : String(error) }, transfer: [] };
      }
    },
    cachedRun: () => cache?.runId ?? null,
  };
}
