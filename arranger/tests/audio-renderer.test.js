// @ts-check
// Tests for audio/render-service.js and audio/audio-renderer.js: the sound of a run is rendered
// off the page's thread. The service is the worker's brain (a pure function of a message); the
// renderer is the page's side, tested against a fake worker that runs the service in the same
// thread, so the protocol, the stale-render rule and the fallback are checked without a browser.
//
// The rules (audit L12, L13): the page never freezes while a pack renders (a Mega Drive render
// takes ten seconds); the big buffers come back by transfer, not copy; a render the visitor has
// already replaced is ignored, and its worker is stopped so it does not hold the CPU; and
// without Web Workers the render happens in the page, as before.

import assert from "node:assert/strict";
import { test } from "node:test";

import { renderRunAudio } from "../src/audio/run-audio.js";
import { createAudioRenderer } from "../src/audio/audio-renderer.js";
import { createRenderService } from "../src/audio/render-service.js";
import { leadSheetVoices, renderVoices } from "../src/audio/plain-synth.js";
import { matchLoudness } from "../src/audio/loudness.js";
import { leadSheetFromJson } from "../src/core/leadsheet.js";
import { totalBeats } from "../src/core/meter.js";
import { readFixture } from "./helpers.js";

const RATE = 2000;

function korobeiniki() {
  const plan = readFixture("plans/korobeiniki-s1.json");
  const leadSheet = leadSheetFromJson(readFixture("leadsheets/korobeiniki.json"));
  /** @type {Record<string, Array<{pitch: number, onset: number, duration: number, velocity: number}>>} */
  const channels = {};
  for (const [name, notes] of Object.entries(plan.arrangement)) {
    channels[name] = notes.map((/** @type {number[]} */ [pitch, onset, duration, velocity]) => ({ pitch, onset, duration, velocity }));
  }
  return {
    id: "korobeiniki-s1",
    arrangement: { tempoBpm: leadSheet.tempoBpm, channels },
    voices: leadSheetVoices(leadSheet),
    tempoBpm: leadSheet.tempoBpm,
    durationBeats: totalBeats(leadSheet.bars),
  };
}

/**
 * A worker that runs the service in this thread and answers on the next turn of the event loop,
 * like a real one. `hold` keeps the answers back until the test releases them.
 * @param {{hold?: boolean}} [options]
 */
function loopbackWorker(options = {}) {
  const service = createRenderService();
  const worker = {
    terminated: false,
    posted: /** @type {any[]} */ ([]),
    /** @type {Array<() => void>} */
    held: [],
    /** @type {((event: {data: any}) => void) | null} */
    onmessage: null,
    onerror: /** @type {((event: any) => void) | null} */ (null),
    postMessage(/** @type {any} */ message) {
      worker.posted.push(message);
      const answer = () => {
        if (worker.terminated) return;
        const { reply } = service.handle(message);
        worker.onmessage?.({ data: reply });
      };
      if (options.hold) worker.held.push(answer);
      else setImmediate(answer);
    },
    terminate() {
      worker.terminated = true;
    },
    release() {
      for (const answer of worker.held.splice(0)) answer();
    },
  };
  return worker;
}

test("the service renders a run exactly as the page would: same stems, same bus gain, same matched original", () => {
  const run = korobeiniki();
  const service = createRenderService();
  const { reply, transfer } = service.handle({ type: "run", id: 1, run, pack: "nes", sampleRate: RATE });
  const expected = renderRunAudio(run, "nes", RATE, null);

  assert.equal(reply.type, "done");
  assert.equal(reply.id, 1);
  assert.deepEqual(Object.keys(reply.audio.stems), ["P1", "P2", "TR", "NO"]);
  assert.deepEqual([...reply.audio.stems.TR], [...expected.stems.TR]);
  assert.equal(reply.audio.busScale, expected.busScale);
  assert.deepEqual([...reply.audio.originalSamples], [...expected.originalSamples]);
  assert.equal(reply.audio.originalRaw, null, "the plain render stays in the worker: it is not sent back");
  assert.ok(transfer.length >= 5, "the four stems and the original go by transfer");
});

test("every transferred buffer belongs to one array alone, so moving it cannot take another array's data", () => {
  const { reply, transfer } = createRenderService().handle({ type: "run", id: 1, run: korobeiniki(), pack: "nes", sampleRate: RATE });
  const arrays = [...Object.values(reply.audio.stems), reply.audio.originalSamples];

  assert.equal(new Set(transfer).size, transfer.length, "no buffer is listed twice");
  for (const array of arrays) {
    assert.ok(transfer.includes(array.buffer));
    assert.equal(array.byteOffset, 0);
    assert.equal(array.buffer.byteLength, array.byteLength);
  }
});

test("the service keeps the plain render of the song between packs, so a pack change does not render it again", () => {
  const run = korobeiniki();
  const service = createRenderService();
  service.handle({ type: "run", id: 1, run, pack: "nes", sampleRate: RATE });
  const second = service.handle({ type: "run", id: 2, run, pack: "plain", sampleRate: RATE });
  const expected = renderRunAudio(run, "plain", RATE, renderRunAudio(run, "nes", RATE, null));

  assert.deepEqual([...second.reply.audio.originalSamples], [...expected.originalSamples]);
  assert.equal(service.cachedRun(), "korobeiniki-s1");
});

test("a preview message answers with the original, loudness matched, as the page's preview does", () => {
  const run = korobeiniki();
  const { reply, transfer } = createRenderService().handle({
    type: "original", id: 7, voices: run.voices, tempoBpm: run.tempoBpm, sampleRate: RATE, beats: 16,
  });
  const rendered = renderVoices(run.voices, run.tempoBpm, RATE, 16);

  assert.equal(reply.type, "done");
  assert.deepEqual([...reply.samples], [...matchLoudness(rendered, rendered, RATE).a]);
  assert.deepEqual(transfer, [reply.samples.buffer]);
});

test("an error in a render comes back as an error reply, not as an exception that would kill the worker", () => {
  const { reply } = createRenderService().handle({ type: "run", id: 4, run: { ...korobeiniki(), arrangement: null }, pack: "nes", sampleRate: RATE });

  assert.equal(reply.type, "error");
  assert.equal(reply.id, 4);
  assert.equal(typeof reply.message, "string");
});

test("the renderer sends the run to the worker and resolves with its audio", async () => {
  const worker = loopbackWorker();
  const renderer = createAudioRenderer({ createWorker: () => worker });
  const run = korobeiniki();

  const audio = await renderer.renderRun(run, "nes", RATE, null);
  const expected = renderRunAudio(run, "nes", RATE, null);

  assert.equal(worker.posted.length, 1);
  assert.equal(worker.posted[0].type, "run");
  assert.equal(audio.pack, "nes");
  assert.equal(audio.sampleRate, RATE);
  assert.deepEqual([...audio.stems.P1], [...expected.stems.P1]);
});

test("audio already rendered for this pack and rate is returned without asking the worker", async () => {
  const worker = loopbackWorker();
  const renderer = createAudioRenderer({ createWorker: () => worker });
  const run = korobeiniki();
  const first = await renderer.renderRun(run, "nes", RATE, null);

  const again = await renderer.renderRun(run, "nes", RATE, first);

  assert.equal(again, first);
  assert.equal(worker.posted.length, 1);
});

test("a render started while another is still running stops the old worker and ignores its answer", async () => {
  const workers = [loopbackWorker({ hold: true }), loopbackWorker()];
  const renderer = createAudioRenderer({ createWorker: () => /** @type {any} */ (workers.shift()) });
  const run = korobeiniki();
  const stale = renderer.renderRun(run, "megadrive", RATE, null);
  const staleOutcome = stale.then(() => "resolved", (error) => error.stale ? "stale" : "failed");

  const fresh = await renderer.renderRun(run, "nes", RATE, null);

  assert.equal(await staleOutcome, "stale", "the replaced render is rejected as stale");
  assert.equal(fresh.pack, "nes");
});

test("a failed render rejects with the worker's message", async () => {
  const worker = loopbackWorker();
  const renderer = createAudioRenderer({ createWorker: () => worker });

  await assert.rejects(() => renderer.renderRun({ ...korobeiniki(), arrangement: null }, "nes", RATE, null), /./);
});

test("without Web Workers the render happens in the page, with the same result", async () => {
  const renderer = createAudioRenderer({ createWorker: null });
  const run = korobeiniki();

  const audio = await renderer.renderRun(run, "nes", RATE, null);
  const expected = renderRunAudio(run, "nes", RATE, null);

  assert.deepEqual([...audio.stems.NO], [...expected.stems.NO]);
  assert.equal(audio.busScale, expected.busScale);
  assert.ok(audio.originalRaw instanceof Float32Array, "the page keeps the plain render itself");
});

test("a worker that cannot start sends the render to the page instead of failing it", async () => {
  const renderer = createAudioRenderer({
    createWorker: () => {
      throw new Error("blocked by a content security policy");
    },
  });

  const audio = await renderer.renderRun(korobeiniki(), "nes", RATE, null);

  assert.equal(audio.pack, "nes");
});

test("the preview's original is rendered by the worker too", async () => {
  const worker = loopbackWorker();
  const renderer = createAudioRenderer({ createWorker: () => worker });
  const run = korobeiniki();

  const samples = await renderer.renderOriginal(run.voices, run.tempoBpm, RATE, 8);
  const rendered = renderVoices(run.voices, run.tempoBpm, RATE, 8);

  assert.deepEqual([...samples], [...matchLoudness(rendered, rendered, RATE).a]);
});

test("disposing stops the worker", async () => {
  const worker = loopbackWorker();
  const renderer = createAudioRenderer({ createWorker: () => worker });
  await renderer.renderRun(korobeiniki(), "nes", RATE, null);

  renderer.dispose();

  assert.equal(worker.terminated, true);
});
