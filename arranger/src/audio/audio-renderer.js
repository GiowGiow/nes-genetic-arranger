// @ts-check
// The audio renderer: the page's side of the render worker.
//
// `renderRun` gives the audio of a run for a sound pack, as `renderRunAudio` does, but a worker
// makes it, so the page keeps answering while it renders. The big buffers come back by transfer.
//
// - A render that the visitor has replaced (another pack chosen, another run ended) is stale.
//   The worker cannot be interrupted in the middle of a ten-second render, so the renderer stops
//   it (`terminate`) and starts a fresh one for the new request; the stale promise rejects with
//   an error whose `stale` is true, which callers ignore.
// - Without Web Workers, or when the browser refuses to start one (a content security policy),
//   the render runs in the page after a turn of the event loop, exactly as before this module.
// - The worker keeps the original's plain render for the run it last rendered, so the page's
//   `RunAudio.originalRaw` is null for audio the worker made.

import { matchLoudness } from "./loudness.js";
import { renderVoices } from "./plain-synth.js";
import { renderRunAudio } from "./run-audio.js";

/**
 * @typedef {object} WorkerLike
 * @property {(message: unknown, transfer?: ArrayBuffer[]) => void} postMessage
 * @property {(() => void) | undefined} [terminate]
 * @property {((event: {data: any}) => void) | null} onmessage
 * @property {((event: any) => void) | null} onerror
 */

/** @returns {(() => WorkerLike) | null} a function that starts the render worker, or null without Web Workers */
function defaultCreateWorker() {
  if (typeof Worker !== "function") return null;
  return () => /** @type {WorkerLike} */ (/** @type {unknown} */ (new Worker(new URL("./render-worker.js", import.meta.url), { type: "module" })));
}

/**
 * The error a replaced render ends with.
 * @returns {Error & {stale: true}}
 */
function staleError() {
  return Object.assign(new Error("this render was replaced by a newer one"), { stale: /** @type {const} */ (true) });
}

/**
 * Make the renderer.
 *
 * @param {{createWorker?: (() => WorkerLike) | null}} [parts] `createWorker` starts a render worker
 *   (default: the real module worker, when the browser has Web Workers); null renders in the page
 * @returns {{
 *   renderRun: (run: any, soundPack: string, sampleRate: number, kept: import("./run-audio.js").RunAudio | null) => Promise<import("./run-audio.js").RunAudio>,
 *   renderOriginal: (voices: any, tempoBpm: number, sampleRate: number, beats: number) => Promise<Float32Array>,
 *   dispose: () => void,
 * }}
 * @example
 * const renderer = createAudioRenderer();
 * run.audio = await renderer.renderRun(run, "megadrive", context.sampleRate, run.audio); // the page stays live
 */
export function createAudioRenderer({ createWorker = defaultCreateWorker() } = {}) {
  /** @type {WorkerLike | null} */
  let worker = null;
  let nextId = 1;
  /** @type {Map<number, {resolve: (value: any) => void, reject: (error: Error) => void}>} */
  const pending = new Map();
  let workerBroken = createWorker === null;

  function stopWorker() {
    worker?.terminate?.();
    worker = null;
  }

  /** @param {Error} error */
  function failAll(error) {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  /** @returns {WorkerLike | null} */
  function ensureWorker() {
    if (workerBroken || !createWorker) return null;
    if (worker) return worker;
    try {
      worker = createWorker();
    } catch {
      workerBroken = true; // blocked: the page renders from now on
      return null;
    }
    worker.onmessage = (event) => {
      const reply = event.data;
      const request = pending.get(reply?.id);
      if (!request) return; // a reply to a request that was replaced
      pending.delete(reply.id);
      if (reply.type === "error") request.reject(new Error(reply.message));
      else request.resolve(reply);
    };
    worker.onerror = (event) => {
      stopWorker();
      workerBroken = true;
      failAll(new Error(event?.message ?? "the render worker failed"));
    };
    return worker;
  }

  /**
   * @param {any} message the request, without its id
   * @param {ArrayBuffer[]} [transfer]
   * @returns {Promise<any> | null} the worker's reply, or null when the page must render
   */
  function ask(message, transfer = []) {
    // A request in flight is replaced: stop its worker so a long render does not keep the CPU.
    if (pending.size > 0) {
      failAll(staleError());
      stopWorker();
    }
    const target = ensureWorker();
    if (!target) return null;
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      target.postMessage({ ...message, id }, transfer);
    });
  }

  return {
    async renderRun(run, soundPack, sampleRate, kept) {
      if (kept && kept.pack === soundPack && kept.sampleRate === sampleRate) return kept;
      const reply = await ask({
        type: "run",
        run: { id: run.id, arrangement: run.arrangement, voices: run.voices, tempoBpm: run.tempoBpm, durationBeats: run.durationBeats },
        pack: soundPack,
        sampleRate,
      });
      if (reply) return reply.audio;
      await Promise.resolve(); // let the page paint its busy state before the long job
      return renderRunAudio(run, soundPack, sampleRate, kept);
    },
    async renderOriginal(voices, tempoBpm, sampleRate, beats) {
      const reply = await ask({ type: "original", voices, tempoBpm, sampleRate, beats });
      if (reply) return reply.samples;
      await Promise.resolve();
      const rendered = renderVoices(voices, tempoBpm, sampleRate, beats);
      return matchLoudness(rendered, rendered, sampleRate).a;
    },
    dispose() {
      failAll(staleError());
      stopWorker();
    },
  };
}
