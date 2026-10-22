// @ts-check
// Tests for ui/result-sound.js: what the Result panel's player holds, and when. The player is the
// real one, on a fake Web Audio; the runs are real renders of the Korobeiniki sample.
//
// The rules (the student's report "Preview plays with Original showing, but it is not the
// original", and "after a few runs the app gets slow"): the player only ever holds the sound of
// the song on screen; a preview never leaves an old arrangement to switch to; a run that ends is
// heard first as the arrangement; and a visit of many runs keeps the buffers of one run, one
// graph and one set of sources.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createPlayer } from "../src/audio/player.js";
import { renderRunAudio } from "../src/audio/run-audio.js";
import { leadSheetVoices } from "../src/audio/plain-synth.js";
import { leadSheetFromJson } from "../src/core/leadsheet.js";
import { totalBeats } from "../src/core/meter.js";
import { addRun, audioHolders, runShown } from "../src/ui/run-list.js";
import { createResultSound } from "../src/ui/result-sound.js";
import { FakeContext } from "./fake-audio.js";
import { readFixture } from "./helpers.js";

const RATE = 2000;

/** A run of the Korobeiniki sample, as `finishRun` keeps it. @param {number} index */
function runOf(index) {
  const plan = readFixture("plans/korobeiniki-s1.json");
  const leadSheet = leadSheetFromJson(readFixture("leadsheets/korobeiniki.json"));
  /** @type {Record<string, Array<{pitch: number, onset: number, duration: number, velocity: number}>>} */
  const channels = {};
  for (const [name, notes] of Object.entries(plan.arrangement)) {
    channels[name] = notes.map((/** @type {number[]} */ [pitch, onset, duration, velocity]) => ({ pitch, onset, duration, velocity }));
  }
  return {
    id: `korobeiniki-s${index}`,
    settings: /** @type {any} */ ({ seed: index }),
    bestFitness: 0.9,
    leadSheet,
    arrangement: { tempoBpm: leadSheet.tempoBpm, channels },
    voices: leadSheetVoices(leadSheet),
    tempoBpm: leadSheet.tempoBpm,
    durationBeats: totalBeats(leadSheet.bars),
    audio: /** @type {import("../src/audio/run-audio.js").RunAudio | null} */ (null),
  };
}

/** The real player on a fake context, with the sound of the Result panel on top. */
function resultPanel() {
  const context = new FakeContext();
  const player = createPlayer({ createContext: () => /** @type {any} */ (context) });
  /** @type {ReturnType<typeof runOf>[]} */
  let runs = [];
  const sound = createResultSound({ player, runs: () => runs });
  return {
    context,
    player,
    sound,
    get runs() {
      return runs;
    },
    /** A run just ended: it joins the list and is heard first as the arrangement. @param {ReturnType<typeof runOf>} run @param {string} [pack] */
    finish(run, pack = "nes") {
      runs = addRun(runs, run);
      return sound.showRun(run, pack, RATE, { fresh: true });
    },
  };
}

const intro = new Float32Array(RATE * 2).fill(0.3);
const attached = (/** @type {FakeContext} */ context) => context.sources.filter((source) => !source.disconnected).length;

test("a run that ends is loaded with both versions and heard first as the arrangement", () => {
  const panel = resultPanel();
  panel.player.load({ original: intro }, RATE); // an earlier preview left the original showing
  assert.equal(panel.player.active(), "original");
  const run = runOf(1);
  panel.finish(run);
  assert.equal(panel.player.has("arrangement"), true);
  assert.equal(panel.player.has("original"), true);
  assert.equal(panel.player.active(), "arrangement", "Play after a run plays the new arrangement, not the preview's original");
  assert.equal(run.audio?.pack, "nes");
});

test("a preview of another song unloads the run: the original is the only version, and the run's buffers are freed", () => {
  const panel = resultPanel();
  const run = runOf(1);
  panel.finish(run);
  panel.player.play();
  panel.sound.showIntro(intro, RATE);

  assert.equal(panel.player.has("arrangement"), false, "no arrangement of the old song to switch to");
  assert.equal(panel.player.active(), "original");
  assert.equal(panel.player.duration(), 2, "the preview's length, not the run's");
  assert.equal(run.audio, null, "the old run keeps its notes but not its sound");
  assert.equal(audioHolders(panel.runs), 0);
  panel.player.switchTo("arrangement");
  assert.equal(panel.player.active(), "original", "the arrangement button has nothing to switch to");
});

test("bringing a run back after a preview renders its sound again and shows the arrangement", () => {
  const panel = resultPanel();
  const run = runOf(1);
  panel.finish(run);
  panel.sound.showIntro(intro, RATE);
  panel.sound.showRun(run, "nes", RATE, { fresh: true });
  assert.equal(panel.player.has("arrangement"), true);
  assert.equal(panel.player.active(), "arrangement");
  assert.ok(run.audio);
});

test("a change of sound pack renders the run again in the version being heard", () => {
  const panel = resultPanel();
  const run = runOf(1);
  panel.finish(run);
  panel.player.switchTo("original");
  panel.sound.showRun(run, "plain", RATE, { fresh: false });
  assert.equal(run.audio?.pack, "plain");
  assert.equal(panel.player.active(), "original", "the music goes on in the same version");
});

test("Preview of the song whose run is on screen replays its original from the start and keeps the arrangement to switch to", () => {
  const panel = resultPanel();
  const run = runOf(1);
  panel.finish(run);
  panel.player.seek(1.5);
  const replayed = panel.sound.replayOriginal();
  assert.equal(replayed, true);
  assert.equal(panel.player.active(), "original");
  assert.equal(panel.player.has("arrangement"), true, "the A/B still works");
  assert.equal(panel.player.currentTime(), 0);
  assert.equal(panel.player.isPlaying(), true);
  assert.ok(run.audio, "the run is still on screen, so it keeps its sound");
});

test("replayOriginal with no original loaded does nothing", () => {
  const panel = resultPanel();
  assert.equal(panel.sound.replayOriginal(), false);
  assert.equal(panel.player.isPlaying(), false);
});

test("forget stops the music and empties the player, so a new song cannot play the last one's sound", () => {
  const panel = resultPanel();
  const run = runOf(1);
  panel.finish(run);
  panel.player.play();
  panel.sound.forget();
  assert.equal(panel.player.isPlaying(), false);
  assert.equal(panel.player.duration(), 0);
  assert.equal(panel.player.has("original"), false);
  assert.equal(run.audio, null);
  assert.equal(attached(panel.context), 0);
});

test("runShown finds the run on screen only when it is for the loaded song", () => {
  const runs = [runOf(1), runOf(2)];
  const sheet = runs[1].leadSheet;
  assert.equal(runShown(runs, "korobeiniki-s2", sheet), runs[1]);
  assert.equal(runShown(runs, "korobeiniki-s1", sheet), null, "a run of another reading of the song");
  assert.equal(runShown(runs, null, sheet), null, "no run on screen");
  assert.equal(runShown(runs, "korobeiniki-s9", sheet), null, "an id that is not in the list");
  assert.equal(runShown(runs, "korobeiniki-s2", null), null);
});

test("a visit of many runs, previews and pack changes holds one run's buffers, one graph and one set of sources", () => {
  const panel = resultPanel();
  const packs = ["nes", "plain", "gameboy"];
  for (let index = 1; index <= 14; index += 1) {
    const run = runOf(index);
    panel.finish(run, packs[index % packs.length]);
    panel.player.play();
    panel.player.seek(0.5);
    panel.player.switchTo("original");
    if (index % 3 === 0) panel.sound.showIntro(intro, RATE); // a preview of another song between runs
    if (index % 4 === 0) {
      const shown = panel.runs[0];
      panel.sound.showRun(shown, packs[(index + 1) % packs.length], RATE, { fresh: false });
    }
    assert.ok(audioHolders(panel.runs) <= 1, `run ${index}: audio held by ${audioHolders(panel.runs)} runs`);
    assert.ok(panel.runs.length <= 5);
    assert.ok(attached(panel.context) <= 5, `run ${index}: ${attached(panel.context)} sources attached`);
  }
  assert.equal(panel.context.gains.length, 8, "the graph was built once");
  assert.equal(panel.context.compressors.length, 1);
  panel.player.pause();
  assert.equal(attached(panel.context), 0, "paused: nothing attached");
});
