// @ts-check
// Tests for audio/player.js: the A/B player with a live channel mixer (spec 002 FR-022, spec 005
// story 1, research R2).
//
// Node has no Web Audio, so the tests hand the player a fake AudioContext that records the
// graph: which node connects to which, when each source starts and at what offset, and every
// value scheduled on a gain. They read as the player's rules: the stems play through one gain
// per channel into a bus, a limiter and an A/B switch; a level change ramps a gain over 10 ms
// and never restarts the music; and play, pause, seek, A/B and the end of the music behave as
// they did before the mixer.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CHANNELS, DEFAULT_LEVELS, DEFAULT_VOLUME, channelGains, volumeToGain } from "../src/audio/mixer.js";
import { createPlayer, heardTime } from "../src/audio/player.js";
import { FakeContext, FakeGain, RATE } from "./fake-audio.js";

/** @typedef {import("../src/audio/mixer.js").Levels} Levels */

/** A player on a fake context, and the context to look into. */
function fakePlayer() {
  const context = new FakeContext();
  const player = createPlayer({ createContext: () => /** @type {any} */ (context) });
  return { player, context };
}

/**
 * Samples of `seconds` at RATE, each sample equal to `value`.
 * @param {number} seconds
 * @param {number} value
 */
const tone = (seconds, value) => new Float32Array(Math.round(seconds * RATE)).fill(value);

/** Four stems of 2 s, each with its own constant, so a buffer tells which stem it holds. */
function stems() {
  return { P1: tone(2, 0.1), P2: tone(2, 0.2), TR: tone(2, 0.3), NO: tone(2, 0.4) };
}

/** The sources that play now: started and not stopped. */
const playing = (/** @type {FakeContext} */ context) => context.sources.filter((source) => source.started && !source.stopped);

/**
 * The node a playing source of the given samples feeds.
 * @param {FakeContext} context
 * @param {number} value the constant of the stem
 */
function nodeFedBy(context, value) {
  const source = playing(context).find((candidate) => candidate.buffer?.samples?.[0] === Math.fround(value));
  assert.ok(source, `a playing source for ${value}`);
  assert.equal(source.outputs.length, 1);
  return source.outputs[0];
}

/** The last value ramped on a param, and when the ramp ends. */
function lastRamp(/** @type {FakeParam} */ param) {
  const ramps = param.calls.filter(([kind]) => kind === "ramp");
  return ramps.at(-1);
}

/** @param {number} value */
const round6 = (value) => Math.round(value * 1e6) / 1e6;

test("each stem plays through its own channel gain, then the bus, the limiter and the arrangement switch", () => {
  const { player, context } = fakePlayer();
  player.load({ arrangement: stems(), original: tone(2, 0.5) }, RATE);
  player.play();

  const channelNodes = [0.1, 0.2, 0.3, 0.4].map((value) => nodeFedBy(context, value));
  assert.equal(new Set(channelNodes).size, 4, "four different channel gains");
  const bus = channelNodes[0].outputs[0];
  for (const node of channelNodes) {
    assert.equal(node.kind, "gain");
    assert.deepEqual(node.outputs, [bus], "every channel gain feeds the one bus");
  }
  assert.equal(bus.kind, "gain");
  const [limiter] = bus.outputs;
  assert.equal(limiter.kind, "compressor");
  const [arrangementSwitch] = limiter.outputs;
  assert.equal(arrangementSwitch.kind, "gain");

  const originalSwitch = nodeFedBy(context, 0.5);
  assert.notEqual(originalSwitch, arrangementSwitch);
  assert.equal(originalSwitch.outputs.length, 1, "the original skips the mixer but not the master volume");
  const [master] = arrangementSwitch.outputs;
  assert.deepEqual(originalSwitch.outputs, [master], "both versions end in the one master volume");
  assert.deepEqual(master.outputs, [context.destination]);
  assert.equal(playing(context).length, 5);
});

test("the limiter catches peaks at -1 dBFS: hard knee, ratio 20, 3 ms attack, 100 ms release", () => {
  const { player, context } = fakePlayer();
  player.load({ arrangement: stems() }, RATE);
  const [limiter] = context.compressors;
  assert.deepEqual(
    [limiter.threshold.value, limiter.knee.value, limiter.ratio.value, limiter.attack.value, limiter.release.value],
    [-1, 0, 20, 0.003, 0.1],
  );
});

test("the graph is built once per context: loads, plays and seeks only add sources", () => {
  const { player, context } = fakePlayer();
  player.load({ arrangement: stems(), original: tone(2, 0.5) }, RATE);
  const gains = context.gains.length;
  assert.equal(gains, 8, "four channels, the bus, the two switches and the master volume");
  player.play();
  player.seek(1);
  player.load({ arrangement: stems(), original: tone(2, 0.5) }, RATE);
  player.load({ arrangement: tone(2, 0.6) }, RATE);
  player.play();
  assert.equal(context.gains.length, gains);
  assert.equal(context.compressors.length, 1);
});

test("the channel gains start at the default levels", () => {
  const { player, context } = fakePlayer();
  player.load({ arrangement: stems() }, RATE);
  player.play();
  const expected = channelGains(DEFAULT_LEVELS);
  [0.1, 0.2, 0.3, 0.4].forEach((value, index) => {
    const gain = /** @type {FakeGain} */ (nodeFedBy(context, value));
    assert.equal(round6(gain.gain.value), round6(expected[CHANNELS[index]]), CHANNELS[index]);
  });
});

test("setLevels ramps each channel gain to its new level over 10 ms, without restarting the music", () => {
  const { player, context } = fakePlayer();
  player.load({ arrangement: stems() }, RATE);
  player.play();
  context.currentTime = 0.5;
  const sourcesBefore = context.sources.length;
  /** @type {Levels} */
  const levels = { P1: 0, P2: -6, TR: 6, NO: -12, muted: { P1: false, P2: false, TR: false, NO: false } };

  player.setLevels(levels);

  const expected = channelGains(levels);
  [0.1, 0.2, 0.3, 0.4].forEach((value, index) => {
    const { gain } = /** @type {FakeGain} */ (nodeFedBy(context, value));
    const calls = gain.calls.slice(-3);
    assert.deepEqual(calls.map(([kind]) => kind), ["cancel", "set", "ramp"], CHANNELS[index]);
    assert.equal(calls[0][1], 0.5, "cancels what was scheduled from now on");
    assert.equal(calls[1][2], 0.5, "holds the current value now");
    const [, target, end] = /** @type {[string, number, number]} */ (lastRamp(gain));
    assert.equal(round6(target), round6(expected[CHANNELS[index]]), CHANNELS[index]);
    assert.equal(round6(end), 0.51, "the ramp lasts 10 ms");
  });
  assert.equal(context.sources.length, sourcesBefore, "no source restarted");
  assert.equal(player.isPlaying(), true);
  assert.equal(player.currentTime(), 0.5 - 0.02, "the position moves on");
});

test("muting a channel ramps its gain to 0, whatever its level", () => {
  const { player, context } = fakePlayer();
  player.load({ arrangement: stems() }, RATE);
  player.play();
  player.setLevels({ ...DEFAULT_LEVELS, NO: 12, muted: { P1: false, P2: false, TR: false, NO: true } });
  const drums = /** @type {FakeGain} */ (nodeFedBy(context, 0.4));
  assert.equal(lastRamp(drums.gain)?.[1], 0);
  const melody = /** @type {FakeGain} */ (nodeFedBy(context, 0.1));
  assert.equal(lastRamp(melody.gain)?.[1], 1);
});

test("levels set once last across load, play, pause and seek", () => {
  const { player, context } = fakePlayer();
  player.load({ arrangement: stems() }, RATE);
  const levels = { P1: -3, P2: -9, TR: 0, NO: 6, muted: { P1: false, P2: true, TR: false, NO: false } };
  player.setLevels(levels);
  player.play();
  player.pause();
  player.load({ arrangement: stems(), original: tone(2, 0.5) }, RATE);
  player.play();
  player.seek(1.2);

  const expected = channelGains(levels);
  [0.1, 0.2, 0.3, 0.4].forEach((value, index) => {
    const gain = /** @type {FakeGain} */ (nodeFedBy(context, value));
    assert.equal(round6(gain.gain.value), round6(expected[CHANNELS[index]]), CHANNELS[index]);
  });
});

test("levels set before the first load apply when the graph is built", () => {
  const { player, context } = fakePlayer();
  player.setLevels({ ...DEFAULT_LEVELS, muted: { P1: true, P2: false, TR: false, NO: false } });
  player.load({ arrangement: stems() }, RATE);
  player.play();
  const melody = /** @type {FakeGain} */ (nodeFedBy(context, 0.1));
  assert.equal(melody.gain.value, 0);
});

test("the bus gain is the load's busScale, 1 without it, and setBusScale ramps it", () => {
  const { player, context } = fakePlayer();
  player.load({ arrangement: stems() }, RATE, { busScale: 0.25 });
  player.play();
  const bus = /** @type {FakeGain} */ (nodeFedBy(context, 0.1).outputs[0]);
  assert.equal(bus.gain.value, 0.25);

  context.currentTime = 1;
  player.setBusScale(0.5);
  assert.deepEqual(lastRamp(bus.gain), ["ramp", 0.5, 1.01]);
  assert.equal(player.isPlaying(), true);

  player.load({ arrangement: stems() }, RATE);
  assert.equal(bus.gain.value, 1, "a load without busScale plays the arrangement as given");
});

/** A ramp with its end time rounded, so floating-point sums compare equal. @param {any} ramp */
const roundRamp = (ramp) => [ramp[0], ramp[1], round6(ramp[2])];

test("A/B crossfades the two switch gains over 80 ms, one down as the other comes up, and keeps the position and the sources", () => {
  const { player, context } = fakePlayer();
  player.load({ arrangement: stems(), original: tone(2, 0.5) }, RATE);
  player.play();
  const arrangementSwitch = /** @type {FakeGain} */ (nodeFedBy(context, 0.1).outputs[0].outputs[0].outputs[0]);
  const originalSwitch = /** @type {FakeGain} */ (nodeFedBy(context, 0.5));
  assert.deepEqual([arrangementSwitch.gain.value, originalSwitch.gain.value], [1, 0]);
  context.currentTime = 0.7;
  const sourcesBefore = context.sources.length;

  player.switchTo("original");
  assert.equal(player.active(), "original");
  assert.deepEqual(roundRamp(lastRamp(originalSwitch.gain)), ["ramp", 1, 0.78]);
  assert.deepEqual(roundRamp(lastRamp(arrangementSwitch.gain)), ["ramp", 0, 0.78]);
  assert.equal(context.sources.length, sourcesBefore);
  assert.equal(round6(player.currentTime()), 0.68);

  player.switchTo("arrangement");
  assert.equal(lastRamp(arrangementSwitch.gain)?.[1], 1);
  assert.equal(lastRamp(originalSwitch.gain)?.[1], 0);
});

test("A/B to a version that is not loaded changes nothing", () => {
  const { player } = fakePlayer();
  player.load({ arrangement: stems() }, RATE);
  player.switchTo("original");
  assert.equal(player.active(), "arrangement");
  assert.equal(player.has("original"), false);
});

test("a load without the original while it is heard falls back to the arrangement, switches included", () => {
  const { player, context } = fakePlayer();
  player.load({ arrangement: stems(), original: tone(2, 0.5) }, RATE);
  player.switchTo("original");
  player.load({ arrangement: stems() }, RATE);
  player.play();
  assert.equal(player.active(), "arrangement");
  const arrangementSwitch = /** @type {FakeGain} */ (nodeFedBy(context, 0.1).outputs[0].outputs[0].outputs[0]);
  assert.equal(arrangementSwitch.gain.value, 1);
});

test("a load with only the original (a preview of a song, before any arrangement) plays the original", () => {
  const { player } = fakePlayer();
  player.load({ original: tone(2, 0.5) }, RATE);
  assert.equal(player.has("original"), true);
  assert.equal(player.has("arrangement"), false);
  assert.equal(player.active(), "original", "the version that exists is the one heard");
  player.play();
  assert.equal(player.isPlaying(), true);
  player.switchTo("arrangement");
  assert.equal(player.active(), "original", "a version that is not loaded changes nothing");
});

test("a single-buffer arrangement still plays, straight into the bus", () => {
  const { player, context } = fakePlayer();
  player.load({ arrangement: tone(3, 0.6), original: tone(2, 0.5) }, RATE);
  assert.equal(player.duration(), 3);
  assert.equal(player.has("arrangement"), true);
  player.play();

  const bus = nodeFedBy(context, 0.6);
  assert.equal(bus.kind, "gain");
  assert.equal(bus.outputs[0].kind, "compressor", "the bus feeds the limiter");
  assert.equal(playing(context).length, 2);
});

test("seek restarts every source at the new offset, at one instant", () => {
  const { player, context } = fakePlayer();
  player.load({ arrangement: stems(), original: tone(2, 0.5) }, RATE);
  player.play();
  const first = playing(context);
  context.currentTime = 0.4;

  player.seek(1.5);

  assert.ok(first.every((source) => source.stopped), "the old sources stop");
  const now = playing(context);
  assert.equal(now.length, 5);
  const startTimes = new Set(now.map((source) => source.started?.when));
  assert.equal(startTimes.size, 1, "one start time for all");
  const [when] = startTimes;
  assert.equal(round6(when ?? -1), 0.42, "20 ms after the call");
  for (const source of now) assert.equal(source.started?.offset, 1.5);
  context.currentTime = when ?? 0;
  assert.equal(player.currentTime(), 1.5);
});

test("play, pause and the position work as before: pause keeps the position, play resumes from it", () => {
  const { player, context } = fakePlayer();
  /** @type {number[]} */
  const changes = [];
  player.onChange(() => changes.push(player.currentTime()));
  player.load({ arrangement: stems() }, RATE);
  assert.equal(player.isPlaying(), false);
  player.play();
  context.currentTime = 1.02;
  player.pause();
  assert.equal(player.isPlaying(), false);
  assert.equal(round6(player.currentTime()), 1);
  assert.ok(playing(context).length === 0, "pause stops every source");

  player.toggle();
  assert.equal(player.isPlaying(), true);
  for (const source of playing(context)) assert.equal(round6(source.started?.offset ?? -1), 1);
  assert.ok(changes.length >= 3, "every change is announced");
});

test("when the longest version ends, playback stops and goes back to the start", () => {
  const { player, context } = fakePlayer();
  let announced = 0;
  player.load({ arrangement: stems(), original: tone(3, 0.5) }, RATE);
  player.onChange(() => announced++);
  player.play();
  const longest = playing(context).find((source) => source.buffer?.duration === 3);
  assert.ok(longest?.onended, "the 3 s original watches the end");
  context.currentTime = 3.1;

  longest.onended();

  assert.equal(player.isPlaying(), false);
  assert.equal(player.currentTime(), 0);
  assert.equal(playing(context).length, 0);
  assert.ok(announced >= 2);
});

test("a load while playing keeps the position and the play state", () => {
  const { player, context } = fakePlayer();
  player.load({ arrangement: stems(), original: tone(2, 0.5) }, RATE);
  player.play();
  context.currentTime = 0.82;
  player.load({ arrangement: stems(), original: tone(2, 0.5) }, RATE);
  assert.equal(player.isPlaying(), true);
  for (const source of playing(context)) assert.equal(round6(source.started?.offset ?? -1), 0.8);
});

test("the default context asks for latencyHint 'playback': bigger buffers, so a phone's slow main thread cannot starve the audio", () => {
  /** @type {unknown[]} */
  const asked = [];
  const original = globalThis.AudioContext;
  // A stand-in constructor: it records the options and acts as the fake context.
  globalThis.AudioContext = /** @type {any} */ (
    class extends FakeContext {
      /** @param {unknown} options */
      constructor(options) {
        super();
        asked.push(options);
      }
    }
  );
  try {
    createPlayer().ensureContext();
  } finally {
    globalThis.AudioContext = original;
  }
  assert.deepEqual(asked, [{ latencyHint: "playback" }]);
});

test("playing uses the buffers rendered beforehand: no source is scheduled note by note, so seek, A/B and levels never render again", () => {
  const { player, context } = fakePlayer();
  player.load({ arrangement: stems(), original: tone(2, 0.5) }, RATE);
  const buffersBefore = context.sources.length;
  player.play();
  const sourcesWhenPlaying = context.sources.length - buffersBefore;
  assert.equal(sourcesWhenPlaying, 5, "one source per buffer: four stems and the original");
  player.switchTo("original");
  player.setLevels({ ...DEFAULT_LEVELS, TR: 0 });
  assert.equal(context.sources.length - buffersBefore, 5, "A/B and a level change add no source");
});

// --- Master volume ------------------------------------------------------------------------------

/** The master volume gain: the one gain that feeds the destination. */
function masterOf(/** @type {FakeContext} */ context) {
  const master = context.gains.find((gain) => gain.outputs.includes(/** @type {any} */ (context.destination)));
  assert.ok(master, "a gain feeds the speakers");
  return master;
}

test("the master volume starts at the default 80 percent, a gain of 0.64, before any visitor choice", () => {
  const { player, context } = fakePlayer();
  player.load({ arrangement: stems(), original: tone(2, 0.5) }, RATE);
  assert.equal(round6(masterOf(context).gain.value), round6(volumeToGain(DEFAULT_VOLUME)));
  assert.equal(round6(masterOf(context).gain.value), 0.64);
});

test("setVolume ramps the master gain over 10 ms, without restarting the music", () => {
  const { player, context } = fakePlayer();
  player.load({ arrangement: stems(), original: tone(2, 0.5) }, RATE);
  player.play();
  context.currentTime = 0.5;
  const sources = context.sources.length;

  player.setVolume(50);
  assert.deepEqual(lastRamp(masterOf(context).gain), ["ramp", 0.25, 0.51]);
  player.setVolume(0);
  assert.deepEqual(lastRamp(masterOf(context).gain), ["ramp", 0, 0.51]);
  assert.equal(context.sources.length, sources, "no source is added");
  assert.equal(player.isPlaying(), true);
});

test("a volume set before the first sound applies when the graph is built", () => {
  const { player, context } = fakePlayer();
  player.setVolume(25);
  player.load({ arrangement: stems() }, RATE);
  assert.equal(round6(masterOf(context).gain.value), round6(0.0625));
});

test("the master volume covers both versions and survives loads and A/B", () => {
  const { player, context } = fakePlayer();
  player.load({ arrangement: stems(), original: tone(2, 0.5) }, RATE);
  player.setVolume(60);
  player.play();
  player.switchTo("original");
  player.load({ arrangement: stems(), original: tone(2, 0.5) }, RATE);
  player.load({ original: tone(2, 0.5) }, RATE);
  assert.equal(round6(masterOf(context).gain.value), round6(0.36));
  // Both switches feed the one master, so the original is as loud as the volume says.
  const originalSwitch = nodeFedBy(context, 0.5);
  assert.deepEqual(originalSwitch.outputs, [masterOf(context)]);
});

test("a volume past the slider is clamped: 100 percent is the mix as it is, never louder", () => {
  const { player, context } = fakePlayer();
  player.load({ original: tone(2, 0.5) }, RATE);
  player.setVolume(400);
  assert.equal(masterOf(context).gain.value, 1);
});

// --- What is loaded and what the toggle shows ---------------------------------------------------

test("show chooses the version heard when a load brings both, and a missing version is ignored", () => {
  const { player } = fakePlayer();
  player.load({ arrangement: stems(), original: tone(2, 0.5) }, RATE);
  player.switchTo("original");
  player.load({ arrangement: stems(), original: tone(2, 0.5) }, RATE);
  assert.equal(player.active(), "original", "a plain load keeps the version heard (a change of sound pack goes on in the same version)");
  player.load({ arrangement: stems(), original: tone(2, 0.5) }, RATE, { show: "arrangement" });
  assert.equal(player.active(), "arrangement", "a new arrangement is heard first");
  player.load({ arrangement: stems() }, RATE, { show: "original" });
  assert.equal(player.active(), "arrangement", "the original is not loaded, so it cannot be shown");
});

test("a preview after a run drops the old arrangement: the toggle can only show the original, and the switches say so", () => {
  const { player, context } = fakePlayer();
  player.load({ arrangement: stems(), original: tone(2, 0.5) }, RATE, { show: "arrangement" });
  player.play();
  const arrangementSwitch = /** @type {FakeGain} */ (nodeFedBy(context, 0.1).outputs[0].outputs[0].outputs[0]);
  const originalSwitch = /** @type {FakeGain} */ (nodeFedBy(context, 0.5));
  assert.equal(player.active(), "arrangement");

  // Preview of another song: only its original is loaded.
  player.load({ original: tone(1, 0.7) }, RATE);
  assert.equal(player.has("arrangement"), false);
  assert.equal(player.active(), "original");
  assert.equal(lastRamp(originalSwitch.gain)?.[1], 1);
  assert.equal(lastRamp(arrangementSwitch.gain)?.[1], 0);
  assert.equal(player.duration(), 1, "the old song's two seconds are gone");
  assert.deepEqual(
    playing(context).map((source) => source.buffer?.samples?.[0]),
    [Math.fround(0.7)],
    "only the preview's buffer plays: no old arrangement or original under it",
  );
});

test("unload stops the music and forgets every buffer, so a new song never plays the old one's sound", () => {
  const { player, context } = fakePlayer();
  let announced = 0;
  player.onChange(() => announced++);
  player.load({ arrangement: stems(), original: tone(2, 0.5) }, RATE);
  player.play();
  context.currentTime = 0.5;
  announced = 0;

  player.unload();
  assert.equal(player.isPlaying(), false);
  assert.equal(player.duration(), 0);
  assert.equal(player.currentTime(), 0);
  assert.equal(player.has("arrangement"), false);
  assert.equal(player.has("original"), false);
  assert.equal(playing(context).length, 0);
  assert.equal(announced, 1, "listeners redraw the buttons");
  player.play();
  assert.equal(player.isPlaying(), false, "there is nothing to play");
  // Unloading again, or before any load, is harmless.
  player.unload();
  assert.equal(createPlayer({ createContext: () => /** @type {any} */ (new FakeContext()) }).unload(), undefined);
});

// --- Nothing piles up ----------------------------------------------------------------------------

test("a stopped source is disconnected, so no finished node stays attached to the graph", () => {
  const { player, context } = fakePlayer();
  player.load({ arrangement: stems(), original: tone(2, 0.5) }, RATE);
  player.play();
  const first = [...context.sources];
  player.seek(1);
  assert.ok(first.every((source) => source.stopped && source.disconnected), "a seek stops and disconnects the old sources");
  const second = context.sources.slice(first.length);
  player.pause();
  assert.ok(second.every((source) => source.stopped && source.disconnected), "pause too");
  player.play();
  const third = context.sources.slice(first.length + second.length);
  player.load({ original: tone(1, 0.7) }, RATE);
  assert.ok(third.every((source) => source.stopped && source.disconnected), "a load too");
});

test("many loads, plays and seeks leave at most one set of sources attached, and one graph", () => {
  const { player, context } = fakePlayer();
  for (let run = 0; run < 12; run++) {
    player.load({ arrangement: stems(), original: tone(2, 0.5) }, RATE, { show: "arrangement" });
    player.play();
    player.seek(0.5);
    player.switchTo("original");
    player.setLevels({ ...DEFAULT_LEVELS, TR: run });
    player.setVolume(run * 5);
    player.pause();
  }
  const attached = context.sources.filter((source) => !source.disconnected);
  assert.equal(attached.length, 0, "paused: every source was released");
  player.play();
  assert.equal(context.sources.filter((source) => !source.disconnected).length, 5, "playing: one source per buffer");
  assert.equal(context.gains.length, 8, "the graph was built once");
  assert.equal(context.compressors.length, 1);
});

test("the position is never negative in the 20 ms between the click and the first sound", () => {
  const { player, context } = fakePlayer();
  player.load({ original: tone(2, 0.5) }, RATE);
  player.play();
  assert.equal(player.currentTime(), 0, "the sources start at 0.02 s, but the clock reads 0:00, not -1:59");
  context.currentTime = 0.07;
  assert.equal(round6(player.currentTime()), 0.05);
});

test("output is the master volume's input, so a sound made outside the player (a track preview) obeys the volume", () => {
  const { player, context } = fakePlayer();
  const node = player.output();
  assert.deepEqual(node.outputs, [context.destination]);
  assert.equal(node, masterOf(context));
  assert.equal(player.output(), node, "the same node every time");
});

// The audio clock runs ahead of the ear: `context.currentTime` is the time of the samples being
// computed, and the speakers play them later (the output buffer, the system mixer, Bluetooth).
// The playback view must follow what is heard, or it runs ahead of the music.

test("heardTime follows the output timestamp, moved on by the wall clock since it was taken", () => {
  const context = {
    currentTime: 10.5,
    getOutputTimestamp: () => ({ contextTime: 10.2, performanceTime: 5000 }),
  };
  assert.equal(round6(heardTime(context, 5050)), 10.25, "50 ms after the stamp, 0.05 s later");
  assert.equal(heardTime(context, 9000), 10.5, "never ahead of the audio being computed");
});

test("heardTime falls back on the reported latencies when there is no usable timestamp", () => {
  const silent = { currentTime: 3, outputLatency: 0.15, baseLatency: 0.05, getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }) };
  assert.equal(round6(heardTime(silent, 100)), 2.8);
  assert.equal(heardTime({ currentTime: 3 }, 100), 3, "no latency reported: the audio clock itself");
  assert.equal(heardTime({ currentTime: 0.01, outputLatency: 0.2 }, 0), 0, "never before the start");
});

test("the position the player reports is the one heard, behind the audio clock by the output latency", () => {
  const { player, context } = fakePlayer();
  /** @type {any} */ (context).outputLatency = 0.2;
  player.load({ arrangement: stems() }, RATE);
  player.play();
  context.currentTime = 1;
  assert.equal(round6(player.currentTime()), round6(1 - 0.02 - 0.2));
});

// ---- Live levels for the mixer's meters ----

/** The analyser listening to the channel gain that a stem of this constant feeds. @param {FakeContext} context @param {number} value */
const analyserOf = (context, value) => nodeFedBy(context, value).taps[0];

test("each stem's fader has an analyser listening after it, so the meters read the level the ear gets from that channel", () => {
  const { player, context } = fakePlayer();
  player.load({ arrangement: stems() }, RATE);
  player.play();

  assert.equal(context.analysers.length, 4, "one analyser per stem");
  for (const analyser of context.analysers) assert.equal(analyser.fftSize, 256);
  for (const value of [0.1, 0.2, 0.3, 0.4]) assert.equal(analyserOf(context, value)?.kind, "analyser");
});

test("channelLevels is null while the music is stopped", () => {
  const { player } = fakePlayer();
  assert.equal(player.channelLevels(), null, "nothing loaded");
  player.load({ arrangement: stems() }, RATE);
  assert.equal(player.channelLevels(), null, "loaded but not playing");
  player.play();
  assert.ok(player.channelLevels());
  player.pause();
  assert.equal(player.channelLevels(), null, "paused");
});

test("channelLevels is the linear RMS of what each analyser hears, between 0 and 1", () => {
  const { player, context } = fakePlayer();
  player.load({ arrangement: stems() }, RATE);
  player.play();
  analyserOf(context, 0.1).block = [0.5, -0.5];
  analyserOf(context, 0.2).block = [0.2];
  analyserOf(context, 0.3).block = [0];
  analyserOf(context, 0.4).block = [1, 0, 0, 0];

  const levels = /** @type {Record<string, number>} */ (player.channelLevels());

  assert.equal(round6(levels.P1), 0.5);
  assert.equal(round6(levels.P2), 0.2);
  assert.equal(levels.TR, 0);
  assert.equal(round6(levels.NO), 0.5, "sqrt of the mean of squares: 1 in 4 samples is sqrt(1/4)");
});

test("the analysers are read only when channelLevels is called, not on every frame of the music", () => {
  const { player, context } = fakePlayer();
  player.load({ arrangement: stems() }, RATE);
  player.play();
  player.seek(1);
  assert.deepEqual(context.analysers.map((analyser) => analyser.reads), [0, 0, 0, 0]);

  player.channelLevels();
  assert.deepEqual(context.analysers.map((analyser) => analyser.reads), [1, 1, 1, 1]);
});

test("a muted channel reads as silence because the analyser sits after its fader", () => {
  const { player, context } = fakePlayer();
  player.load({ arrangement: stems() }, RATE);
  player.play();
  const fader = /** @type {FakeGain} */ (nodeFedBy(context, 0.1));

  assert.deepEqual(fader.taps, [analyserOf(context, 0.1)], "the tap is on the fader's output");
});
