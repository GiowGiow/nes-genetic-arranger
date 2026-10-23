// @ts-check
// Tests for audio/megadrive-pack.js: the Mega Drive sound pack (FM voices and a noise chip).
//
// They check the facts the pack's sound rests on: the noise register's two modes and its 2 dB
// volume steps lowered once per video frame, the pitch of each FM voice, and the claim that the
// sound is warm: its highs are far under its body, and each patch has the movement that makes
// it that instrument (a brass swell, an electric piano's ping, a bass slap).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MEGADRIVE_DRUMS,
  MEGADRIVE_PATCHES,
  psgBurst,
  psgGain,
  psgNoiseBits,
  psgVolumeStep,
  renderMegaDriveStems,
} from "../src/audio/megadrive-pack.js";
import { bandLevelDb, peakFrequency } from "./spectrum.js";

const RATE = 44100;

/**
 * One note of one channel, rendered alone.
 * @param {"P1" | "P2" | "TR" | "NO"} channel
 * @param {number} pitch
 * @param {{beats?: number, velocity?: number}} [options]
 */
function solo(channel, pitch, { beats = 2, velocity = 100 } = {}) {
  const arrangement = { tempoBpm: 120, channels: { [channel]: [{ pitch, onset: 0, duration: beats, velocity }] } };
  return renderMegaDriveStems(arrangement, RATE)[channel];
}

/** @param {Float64Array} samples @param {number} from seconds @param {number} to seconds */
const slice = (samples, from, to) => samples.subarray(Math.floor(from * RATE), Math.floor(to * RATE));

/** @param {Float64Array} samples */
const rms = (samples) => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);

test("the noise register has a 16-step periodic mode and a long white mode", () => {
  const periodic = psgNoiseBits(64, true);
  assert.deepEqual([...periodic.subarray(0, 16)], [...periodic.subarray(16, 32)]);
  assert.equal(periodic.reduce((sum, bit) => sum + bit, 0), 4, "one set bit per 16 steps");

  // Bits 0 and 3 as taps give a sequence of 57,337 steps (the feedback polynomial x^16 + x^3 + 1
  // is not primitive, so it is shorter than the 65,535 that 16 bits could hold)
  const period = 57337;
  const white = psgNoiseBits(period + 300, false);
  const same = (/** @type {number} */ a, /** @type {number} */ b) => white.subarray(a, a + 300).every((bit, i) => bit === white[b + i]);
  assert.ok(same(period, 0), "repeats after 57,337 steps");
  assert.ok(!same(1000, 0) && !same(65535 - 8000, 0), "and not sooner");
  const ones = white.subarray(0, period).reduce((sum, bit) => sum + bit, 0) / period;
  assert.ok(ones > 0.45 && ones < 0.55, `about as many ones as zeros (${ones.toFixed(3)})`);
});

test("the noise channel's volume has 16 steps of 2 dB, and a velocity maps to the nearest step", () => {
  assert.equal(psgGain(0), 1);
  assert.ok(Math.abs(psgGain(5) - 10 ** (-10 / 20)) < 1e-12);
  assert.equal(psgGain(15), 0, "step 15 is off");
  assert.equal(psgVolumeStep(127), 0);
  assert.equal(psgVolumeStep(64), 3, "half the velocity is about 6 dB down");
  assert.equal(psgVolumeStep(1), 14, "never off");
});

test("a noise burst is lowered by whole volume steps once per video frame", () => {
  const burst = { shiftHz: 7000, periodic: false, stepsPerFrame: 1, lowpassHz: 20000, gain: 1 };
  const samples = psgBurst(burst, 127, Math.round(0.3 * RATE), RATE);
  const frame = (/** @type {number} */ n) => rms(samples.subarray(Math.round(((n + 0.2) / 60) * RATE), Math.round(((n + 0.8) / 60) * RATE)));
  for (let n = 0; n < 6; n++) {
    const drop = 20 * Math.log10(frame(n) / frame(n + 1));
    assert.ok(Math.abs(drop - 2) < 1, `frame ${n} to ${n + 1}: ${drop.toFixed(2)} dB`);
  }
  // Inside one frame the level is steady
  const early = rms(samples.subarray(Math.round(0.002 * RATE), Math.round(0.006 * RATE)));
  const late = rms(samples.subarray(Math.round(0.011 * RATE), Math.round(0.015 * RATE)));
  assert.ok(Math.abs(20 * Math.log10(early / late)) < 1.5);
});

test("each pitched patch has four operators and a valid algorithm", () => {
  for (const [channel, patch] of Object.entries(MEGADRIVE_PATCHES)) {
    assert.equal(patch.operators.length, 4, channel);
    assert.ok(patch.algorithm >= 0 && patch.algorithm <= 7, channel);
    assert.ok(patch.feedback >= 0 && patch.feedback <= 7, channel);
  }
});

test("every voice sounds at the note's pitch: the bass at its frequency, the lead and the piano with their partials on its harmonics", () => {
  // A1 = 55 Hz: the sine fundamental of the bass is the strongest partial
  assert.ok(Math.abs(peakFrequency(slice(solo("TR", 33), 0.3, 0.95), RATE) - 55) < 1);
  // A4 = 440 Hz: the brass and the piano put their strongest partial on a multiple of 440
  for (const channel of /** @type {const} */ (["P1", "P2"])) {
    const strongest = peakFrequency(slice(solo(channel, 69), 0.2, 0.95), RATE);
    const harmonic = Math.round(strongest / 440);
    // (the lead's two pairs are 12 cents apart, so a partial can sit up to 0.7% off the harmonic)
    assert.ok(harmonic >= 1 && Math.abs(strongest / (440 * harmonic) - 1) < 0.01, `${channel}: ${strongest.toFixed(1)} Hz`);
  }
});

test("the sound is warm: almost nothing above 5 kHz, and little above 3 kHz", () => {
  for (const [channel, pitch] of /** @type {const} */ ([["P1", 76], ["P2", 72], ["TR", 40]])) {
    const samples = solo(channel, pitch);
    const total = bandLevelDb(samples, RATE, 20, 20000);
    assert.ok(bandLevelDb(samples, RATE, 5000, 20000) < total - 35, `${channel}: above 5 kHz`);
    assert.ok(bandLevelDb(samples, RATE, 3000, 20000) < total - 20, `${channel}: above 3 kHz`);
  }
});

test("the brass lead swells and brightens, then settles mellower", () => {
  const samples = solo("P1", 60, { beats: 4 });
  const brightness = (/** @type {number} */ from, /** @type {number} */ to) => {
    const part = slice(samples, from, to);
    return bandLevelDb(part, RATE, 600, 6000, 1024) - bandLevelDb(part, RATE, 20, 6000, 1024);
  };
  assert.ok(brightness(0.05, 0.1) > brightness(0, 0.025) + 6, "brighter at the end of the swell than at the very start");
  assert.ok(brightness(0.05, 0.1) > brightness(1, 1.8) + 3, "brighter at the swell than when settled");
});

test("the electric piano pings at the attack and rings on mellow", () => {
  const samples = solo("P2", 69, { beats: 4 });
  const highShare = (/** @type {number} */ from, /** @type {number} */ to) => {
    const part = slice(samples, from, to);
    return bandLevelDb(part, RATE, 1500, 8000, 1024) - bandLevelDb(part, RATE, 20, 8000, 1024);
  };
  assert.ok(highShare(0.002, 0.04) > highShare(0.5, 1) + 8, `ping ${highShare(0.002, 0.04).toFixed(1)} dB, body ${highShare(0.5, 1).toFixed(1)} dB`);
  // Its level falls over the note, as a struck tine's does
  assert.ok(rms(slice(samples, 1.2, 1.5)) < rms(slice(samples, 0.02, 0.3)) * 0.8);
});

test("the slap bass has a bright pop at the start and a round fundamental after it", () => {
  const samples = solo("TR", 40, { beats: 4 });
  const upperShare = (/** @type {number} */ from, /** @type {number} */ to) => {
    const part = slice(samples, from, to);
    return bandLevelDb(part, RATE, 300, 5000, 1024) - bandLevelDb(part, RATE, 20, 5000, 1024);
  };
  assert.ok(upperShare(0.002, 0.05) > upperShare(0.6, 1) + 10, `pop ${upperShare(0.002, 0.05).toFixed(1)}, round ${upperShare(0.6, 1).toFixed(1)}`);
});

test("a louder velocity makes a louder note", () => {
  for (const channel of /** @type {const} */ (["P1", "P2", "TR"])) {
    assert.ok(rms(solo(channel, 60, { velocity: 120 })) > rms(solo(channel, 60, { velocity: 50 })) * 1.5, channel);
  }
  assert.ok(rms(solo("NO", 38, { velocity: 120 })) > rms(solo("NO", 38, { velocity: 50 })) * 1.3);
});

test("the kick is low, the hi-hat is high, and the snare has a body and a noise burst", () => {
  const kick = solo("NO", 36, { beats: 1 });
  const snare = solo("NO", 38, { beats: 1 });
  const hat = solo("NO", 42, { beats: 1 });
  const share = (/** @type {Float64Array} */ samples, /** @type {number} */ low, /** @type {number} */ high) =>
    bandLevelDb(samples, RATE, low, high) - bandLevelDb(samples, RATE, 20, 20000);
  assert.ok(share(kick, 20, 250) > -1, "the kick lives under 250 Hz");
  assert.ok(share(hat, 2000, 20000) > -3, "the hi-hat lives above 2 kHz");
  assert.ok(share(snare, 120, 400) > -12, "the snare has a tonal body");
  assert.ok(share(snare, 1500, 20000) > -12, "and a noise burst");
  assert.deepEqual(Object.keys(MEGADRIVE_DRUMS).map(Number), [36, 38, 42]);
});

test("a drum hit dies away, and the next hit cuts the one before", () => {
  const kick = solo("NO", 36, { beats: 1 });
  assert.ok(rms(slice(kick, 0.25, 0.3)) < rms(slice(kick, 0, 0.05)) * 0.05, "a kick fades in a quarter of a second");

  // A kick, then a hi-hat an eighth of a second later: after the hat is over, nothing rings
  const arrangement = {
    tempoBpm: 120,
    channels: { NO: [{ pitch: 36, onset: 0, duration: 0.25, velocity: 100 }, { pitch: 42, onset: 0.25, duration: 0.25, velocity: 100 }] },
  };
  const hits = renderMegaDriveStems(arrangement, RATE).NO;
  assert.ok(rms(slice(hits, 0.125, 0.14)) > 0, "the hat sounds at 0.125 s");
  assert.ok(rms(slice(hits, 0.225, 0.3)) < 1e-4, "no kick tail past the hat's own end");
});

test("rendering is deterministic and fits the timeline of the chip render", () => {
  const arrangement = {
    tempoBpm: 100,
    channels: {
      P1: [{ pitch: 72, onset: 0, duration: 1, velocity: 100 }],
      P2: [{ pitch: 64, onset: 0, duration: 0.5, velocity: 90 }, { pitch: 67, onset: 0.5, duration: 0.5, velocity: 90 }],
      TR: [{ pitch: 36, onset: 0, duration: 2, velocity: 100 }],
      NO: [{ pitch: 36, onset: 0, duration: 0.5, velocity: 100 }, { pitch: 38, onset: 1, duration: 0.5, velocity: 100 }],
    },
  };
  const first = renderMegaDriveStems(arrangement, RATE);
  assert.deepEqual(renderMegaDriveStems(arrangement, RATE), first);
  assert.equal(first.P1.length, Math.ceil((2 * 0.6 + 0.15) * RATE));
});
