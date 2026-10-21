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

import { CHANNELS, DEFAULT_LEVELS, channelGains } from "../src/audio/mixer.js";
import { createPlayer } from "../src/audio/player.js";

/** @typedef {import("../src/audio/mixer.js").Levels} Levels */

const RATE = 100;

/** An AudioParam that records what is scheduled on it; `value` follows the last target. */
class FakeParam {
  /** @param {number} value */
  constructor(value) {
    this.value = value;
    /** @type {Array<[string, ...number[]]>} */
    this.calls = [];
  }
  /** @param {number} value @param {number} time */
  setValueAtTime(value, time) {
    this.calls.push(["set", value, time]);
    this.value = value;
    return this;
  }
  /** @param {number} value @param {number} time */
  linearRampToValueAtTime(value, time) {
    this.calls.push(["ramp", value, time]);
    this.value = value;
    return this;
  }
  /** @param {number} time */
  cancelScheduledValues(time) {
    this.calls.push(["cancel", time]);
    return this;
  }
}

class FakeNode {
  /** @param {string} kind */
  constructor(kind) {
    this.kind = kind;
    /** @type {FakeNode[]} */
    this.outputs = [];
  }
  /** @param {FakeNode} node */
  connect(node) {
    this.outputs.push(node);
    return node;
  }
}

class FakeGain extends FakeNode {
  constructor() {
    super("gain");
    this.gain = new FakeParam(1);
  }
}

class FakeCompressor extends FakeNode {
  constructor() {
    super("compressor");
    this.threshold = new FakeParam(-24);
    this.knee = new FakeParam(30);
    this.ratio = new FakeParam(12);
    this.attack = new FakeParam(0.003);
    this.release = new FakeParam(0.25);
  }
}

class FakeBuffer {
  /** @param {number} channels @param {number} length @param {number} sampleRate */
  constructor(channels, length, sampleRate) {
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    /** @type {Float32Array | null} */
    this.samples = null;
  }
  /** @param {Float32Array} samples */
  copyToChannel(samples) {
    this.samples = Float32Array.from(samples);
  }
}

class FakeSource extends FakeNode {
  constructor() {
    super("source");
    /** @type {FakeBuffer | null} */
    this.buffer = null;
    /** @type {{when: number, offset: number} | null} */
    this.started = null;
    this.stopped = false;
    /** @type {(() => void) | null} */
    this.onended = null;
  }
  /** @param {number} when @param {number} offset */
  start(when, offset) {
    this.started = { when, offset };
  }
  stop() {
    // As in Web Audio, a source that never started cannot stop.
    if (!this.started) throw new Error("InvalidStateError");
    this.stopped = true;
  }
}

class FakeContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = RATE;
    this.state = "running";
    this.destination = new FakeNode("destination");
    /** @type {FakeGain[]} */
    this.gains = [];
    /** @type {FakeSource[]} */
    this.sources = [];
    /** @type {FakeCompressor[]} */
    this.compressors = [];
  }
  createGain() {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  createDynamicsCompressor() {
    const compressor = new FakeCompressor();
    this.compressors.push(compressor);
    return compressor;
  }
  /** @param {number} channels @param {number} length @param {number} sampleRate */
  createBuffer(channels, length, sampleRate) {
    return new FakeBuffer(channels, length, sampleRate);
  }
  resume() {
    this.state = "running";
  }
}

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
  assert.deepEqual(arrangementSwitch.outputs, [context.destination]);

  const originalSwitch = nodeFedBy(context, 0.5);
  assert.notEqual(originalSwitch, arrangementSwitch);
  assert.deepEqual(originalSwitch.outputs, [context.destination], "the original skips the mixer");
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
  assert.equal(gains, 7, "four channels, the bus and the two switches");
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

test("A/B ramps the two switch gains over 10 ms and keeps the position and the sources", () => {
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
  assert.deepEqual(lastRamp(originalSwitch.gain), ["ramp", 1, 0.71]);
  assert.deepEqual(lastRamp(arrangementSwitch.gain), ["ramp", 0, 0.71]);
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
