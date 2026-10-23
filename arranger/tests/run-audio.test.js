// @ts-check
// Tests for audio/run-audio.js and the audio of the run list (ui/run-list.js): a run keeps the
// small things that make its sound (arrangement, original voices) always, and the big things
// (four stems, the original's samples, about 30 MB a minute at 44.1 kHz) only while it is the
// run on screen. Any other run renders its sound again when it is brought back.

import { test } from "node:test";
import assert from "node:assert/strict";

import { PEAK_LEVEL } from "../src/audio/chip-synth.js";
import { matchMixLoudness, defaultLevels, mixStems } from "../src/audio/mixer.js";
import { renderRunAudio } from "../src/audio/run-audio.js";
import { leadSheetVoices, renderVoices } from "../src/audio/plain-synth.js";
import { SOUND_PACKS, renderPackStems } from "../src/audio/sound-packs.js";
import { leadSheetFromJson } from "../src/core/leadsheet.js";
import { totalBeats } from "../src/core/meter.js";
import { RUN_LIMIT, addRun, audioHolders, releaseAudio } from "../src/ui/run-list.js";
import { readFixture } from "./helpers.js";

// A low rate keeps the test fast; the rules do not depend on it.
const RATE = 4000;

/** The Korobeiniki sample as a run keeps it: the arrangement and the original's voices. */
function korobeiniki() {
  const plan = readFixture("plans/korobeiniki-s1.json");
  const leadSheet = leadSheetFromJson(readFixture("leadsheets/korobeiniki.json"));
  /** @type {Record<string, Array<{pitch: number, onset: number, duration: number, velocity: number}>>} */
  const channels = {};
  for (const [name, notes] of Object.entries(plan.arrangement)) {
    channels[name] = notes.map((/** @type {number[]} */ [pitch, onset, duration, velocity]) => ({ pitch, onset, duration, velocity }));
  }
  return {
    arrangement: { tempoBpm: leadSheet.tempoBpm, channels },
    voices: leadSheetVoices(leadSheet),
    tempoBpm: leadSheet.tempoBpm,
    durationBeats: totalBeats(leadSheet.bars),
  };
}

test("a run's audio is its pack's four stems, the bus gain and the original matched to the mix", () => {
  const run = korobeiniki();
  const audio = renderRunAudio(run, "nes", RATE, null);
  assert.equal(audio.pack, "nes");
  assert.equal(audio.sampleRate, RATE);
  assert.deepEqual(Object.keys(audio.stems), ["P1", "P2", "TR", "NO"]);
  const stems = renderPackStems("nes", run.arrangement, RATE);
  assert.deepEqual(audio.stems.TR, stems.TR);
  const original = renderVoices(run.voices, run.tempoBpm, RATE, run.durationBeats);
  assert.deepEqual(audio.originalRaw, original, "the original, plainly rendered, before its loudness is matched");
  const matched = matchMixLoudness(stems, original, RATE, defaultLevels("nes"));
  assert.equal(audio.busScale, matched.busScale);
  assert.deepEqual(audio.originalSamples, matched.original);
});

test("the audio already rendered for this pack and rate is returned as it is", () => {
  const run = korobeiniki();
  const audio = renderRunAudio(run, "nes", RATE, null);
  assert.equal(renderRunAudio(run, "nes", RATE, audio), audio);
});

test("another sound pack renders new stems but keeps the original's render, only matching it again", () => {
  const run = korobeiniki();
  const nes = renderRunAudio(run, "nes", RATE, null);
  const plain = renderRunAudio(run, "plain", RATE, nes);
  assert.equal(plain.pack, "plain");
  assert.notDeepEqual(plain.stems.P1, nes.stems.P1);
  assert.equal(plain.originalRaw, nes.originalRaw, "the plain render of the song is not made twice");
  assert.deepEqual(plain.originalSamples, matchMixLoudness(plain.stems, nes.originalRaw, RATE, defaultLevels("plain")).original);
});

test("another sample rate renders everything again", () => {
  const run = korobeiniki();
  const slow = renderRunAudio(run, "nes", RATE, null);
  const fast = renderRunAudio(run, "nes", RATE * 2, slow);
  assert.equal(fast.sampleRate, RATE * 2);
  assert.ok(fast.originalRaw.length > slow.originalRaw.length);
});

/** @param {number} index */
const fakeRun = (index) => ({ id: `run-${index}`, settings: /** @type {any} */ ({ seed: index }), bestFitness: 0.9, audio: /** @type {any} */ ({ pack: "nes", index }) });

test("releaseAudio keeps the audio of one run and frees every other run's, which stay in the list", () => {
  let runs = /** @type {ReturnType<typeof fakeRun>[]} */ ([]);
  for (let index = 1; index <= 4; index += 1) runs = addRun(runs, fakeRun(index));
  assert.equal(audioHolders(runs), 4);
  const freed = releaseAudio(runs, "run-2");
  assert.equal(freed, 3);
  assert.equal(audioHolders(runs), 1);
  assert.equal(runs.find((run) => run.id === "run-2")?.audio?.index, 2);
  assert.equal(runs.length, 4, "the runs themselves are still there to be brought back");
  assert.equal(releaseAudio(runs, null), 1, "keeping none frees the last one");
  assert.equal(audioHolders(runs), 0);
});

test("a visit of many runs never holds the audio of more than one", () => {
  let runs = /** @type {ReturnType<typeof fakeRun>[]} */ ([]);
  for (let index = 1; index <= 20; index += 1) {
    const run = fakeRun(index);
    runs = addRun(runs, run);
    releaseAudio(runs, run.id);
    assert.ok(audioHolders(runs) <= 1, `after run ${index}`);
    assert.ok(runs.length <= RUN_LIMIT);
  }
});

test("every sound pack renders a run's audio, with a usable bus gain, and its WAV mix at the pack's levels stays under the ceiling", () => {
  const run = korobeiniki();
  for (const pack of SOUND_PACKS) {
    const audio = renderRunAudio(run, pack.id, RATE, null);
    assert.equal(audio.pack, pack.id);
    assert.ok(Number.isFinite(audio.busScale) && audio.busScale > 0, `${pack.id}: bus gain ${audio.busScale}`);
    for (const channel of /** @type {const} */ (["P1", "P2", "TR", "NO"])) {
      assert.equal(audio.stems[channel].length, audio.stems.P1.length, `${pack.id} ${channel}`);
      assert.ok(audio.stems[channel].some((sample) => sample !== 0), `${pack.id} ${channel} is silent`);
    }
    // The WAV download mixes the stems at the pack's default levels and peaks at -3 dBFS
    const wav = mixStems(audio.stems, defaultLevels(pack.id));
    assert.ok(Math.abs(wav.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0) - PEAK_LEVEL) < 1e-4, pack.id);
  }
});
