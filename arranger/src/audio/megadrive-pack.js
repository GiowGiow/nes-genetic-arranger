// @ts-check
// The Mega Drive sound pack: the arrangement played with FM synthesis and a noise chip, after the
// Sega Mega Drive (Genesis, 1988).
//
// The console has two sound chips, and the pack uses both the way its games did:
//
// - The Yamaha YM2612 is an FM chip with six voices of four operators each (`fm-synth.js` explains
//   FM and the operators). Games spent it on melody, harmony and bass, and so does this pack:
//   * P1, the melody, is a brass-like lead (algorithm 4, two modulator-carrier pairs a few cents
//     apart). The modulators have a slow attack, so the tone swells and brightens the way a
//     brass player's does, and then settles mellower; a delayed vibrato keeps long notes alive.
//   * P2, the harmony, is an electric piano (also algorithm 4): a bell-like modulator that
//     dies in a few tens of milliseconds gives the tine's "ping", a second pair gives the soft,
//     slowly fading body. Notes ring on a little after the key goes up, like the real instrument.
//   * TR, the bass, is the classic FM slap bass: a very bright, feedback-driven modulator that
//     falls away in about 80 ms is the "slap" of the string, and a plain sine pair under it is the
//     round fundamental that is left.
// - The Texas Instruments SN76489 is a four-channel sound chip, three square waves and one noise
//   channel, that the Mega Drive kept from the Master System. Its noise channel is a 16-bit
//   shift register (feedback from bits 0 and 3, 57,337 steps before it repeats) whose clock a
//   program can pick; its volume has 16 steps of 2 dB each, and sound drivers lowered it by hand
//   once per video frame (60 times a second) to make a decay. The pack's snare and hi-hat use
//   exactly that, a stepped noise burst; the kick and the snare's body are FM voices, with a
//   pitch that falls onto the note (`pitchEnvelope`). (The games' sampled drums came from the
//   YM2612's DAC mode; samples would need real recordings, so these are synthesized.)
//
// The Mega Drive's audio is known for its warmth, from an analog output stage that rolls off the
// highs, so everything goes through a gentle low-pass at 8 kHz, and the patches keep their
// modulation index moderate: the sound is bright at the attack and soft after it, never harsh.
// This is an impression made with sine functions, not an emulation of the chip's tables.

import { fmOperator, renderFmNote } from "./fm-synth.js";
import { lowpass } from "./filters.js";
import { noteFrequency, sounding } from "./note-schedule.js";
import { renderLength } from "./chip-synth.js";

/** @typedef {import("./chip-synth.js").ChannelName} ChannelName */
/** @typedef {import("./fm-synth.js").FmPatch} FmPatch */

/** @param {import("./fm-synth.js").FmOperator[]} operators */
const quad = (...operators) => /** @type {import("./fm-synth.js").FmOperator[]} */ (operators);

/**
 * The FM patch of each pitched channel. See the header for what each one is made of.
 * @type {Readonly<Record<"P1" | "P2" | "TR", Readonly<FmPatch>>>}
 * @example
 * MEGADRIVE_PATCHES.TR.algorithm; // 4: two pairs, a slap pair and a sine pair
 */
export const MEGADRIVE_PATCHES = Object.freeze({
  P1: Object.freeze({
    algorithm: 4,
    feedback: 4,
    operators: quad(
      // brass pair, in tune: the modulator swells over 60 ms and settles to a mellow index
      fmOperator({ totalLevel: 10, attack: 0.05, decay1Rate: 40, sustainLevel: 8, decay2Rate: 2, releaseRate: 300 }),
      fmOperator({ totalLevel: 0, attack: 0.02, decay1Rate: 8, sustainLevel: 6, decay2Rate: 1.5, releaseRate: 300 }),
      // brass pair, 12 cents sharp: the beating between the two pairs is the chorus
      fmOperator({ totalLevel: 14, attack: 0.08, decay1Rate: 30, sustainLevel: 8, decay2Rate: 2, releaseRate: 300, detuneCents: 12 }),
      fmOperator({ totalLevel: 4, attack: 0.03, decay1Rate: 8, sustainLevel: 6, decay2Rate: 1.5, releaseRate: 300, detuneCents: 12 }),
    ),
    vibrato: { hz: 5.5, cents: 14, delay: 0.25 },
    // above middle C the modulators go down 9 dB per octave, so a high note stays as mellow as a low one
    brightnessTracking: { fromHz: 260, dbPerOctave: 9 },
  }),
  P2: Object.freeze({
    algorithm: 4,
    feedback: 0,
    operators: quad(
      // the tine: a bell-like modulator (7 times the pitch) that dies in tens of milliseconds
      fmOperator({ multiple: 7, totalLevel: 22, decay1Rate: 1200, sustainLevel: 50, decay2Rate: 100, releaseRate: 300 }),
      fmOperator({ totalLevel: 0, attack: 0.002, decay1Rate: 12, sustainLevel: 24, decay2Rate: 14, releaseRate: 200 }),
      // the body: a soft modulator at the pitch itself, with a slow fade
      fmOperator({ totalLevel: 20, decay1Rate: 40, sustainLevel: 12, decay2Rate: 6, releaseRate: 200 }),
      fmOperator({ totalLevel: 4, attack: 0.003, decay1Rate: 8, sustainLevel: 24, decay2Rate: 10, releaseRate: 200 }),
    ),
  }),
  TR: Object.freeze({
    algorithm: 4,
    feedback: 5,
    operators: quad(
      // the slap: a bright, feedback-driven modulator that is gone in about 80 ms
      fmOperator({ totalLevel: 6, decay1Rate: 300, sustainLevel: 14, decay2Rate: 6, releaseRate: 600 }),
      fmOperator({ totalLevel: 0, decay1Rate: 30, sustainLevel: 10, decay2Rate: 12, releaseRate: 600 }),
      // the fundamental: a nearly pure sine with a trace of modulation
      fmOperator({ totalLevel: 24, decay2Rate: 4, releaseRate: 600 }),
      fmOperator({ totalLevel: 2, decay2Rate: 5, releaseRate: 600 }),
    ),
  }),
});

/**
 * One FM drum: a patch struck at a fixed frequency, for at most `seconds`.
 * @typedef {object} FmDrum
 * @property {FmPatch} patch
 * @property {number} hz the pitch the sound settles on
 * @property {number} seconds how long the hit may last (a later hit cuts it)
 * @property {number} gain level in the drum mix
 */

/**
 * A burst of the noise channel: the register's clock, whether it repeats every 16 steps
 * (`periodic`, a buzz) or every 65,535 (white noise), and how its volume is lowered, in 2 dB
 * steps per video frame.
 * @typedef {object} PsgBurst
 * @property {number} shiftHz how many times per second the shift register moves
 * @property {boolean} periodic
 * @property {number} stepsPerFrame volume steps (2 dB each) lowered on every frame
 * @property {number} lowpassHz a filter on the burst, to keep the noise from being harsh
 * @property {number} gain
 */

/**
 * The drums, by General MIDI drum note: 36 kick, 38 snare, 42 hi-hat. Each is an FM voice, a
 * noise burst, or both.
 * @type {Readonly<Record<number, Readonly<{fm?: FmDrum, psg?: PsgBurst}>>>}
 */
export const MEGADRIVE_DRUMS = Object.freeze({
  36: Object.freeze({
    fm: {
      // a sine with a little feedback that starts 28 semitones high and falls onto 52 Hz in ~25 ms
      patch: {
        algorithm: 7,
        feedback: 3,
        operators: quad(
          fmOperator({ totalLevel: 0, decay1Rate: 110, releaseRate: 800 }),
          fmOperator({ totalLevel: 96 }),
          fmOperator({ totalLevel: 96 }),
          fmOperator({ totalLevel: 96 }),
        ),
        pitchEnvelope: { semitones: 28, seconds: 0.022 },
      },
      hz: 52,
      seconds: 0.3,
      gain: 1,
    },
  }),
  38: Object.freeze({
    fm: {
      // the snare's body: two sines a fifth-ish apart, falling quickly
      patch: {
        algorithm: 7,
        feedback: 2,
        operators: quad(
          fmOperator({ totalLevel: 4, decay1Rate: 300, releaseRate: 800 }),
          fmOperator({ multiple: 1.62, totalLevel: 10, decay1Rate: 400, releaseRate: 800 }),
          fmOperator({ totalLevel: 96 }),
          fmOperator({ totalLevel: 96 }),
        ),
        pitchEnvelope: { semitones: 7, seconds: 0.02 },
      },
      hz: 185,
      seconds: 0.2,
      gain: 0.55,
    },
    psg: { shiftHz: 7000, periodic: false, stepsPerFrame: 1, lowpassHz: 5500, gain: 0.8 },
  }),
  42: Object.freeze({
    psg: { shiftHz: 15000, periodic: false, stepsPerFrame: 3, lowpassHz: 7000, gain: 0.5 },
  }),
});

// The level of each stem, so that the four are about as loud as each other before the page's
// mixer defaults (measured, `audio/mixer.js`) lift the bass and the drums.
const STEM_GAINS = Object.freeze({ P1: 0.8, P2: 0.32, TR: 0.9, NO: 0.4 });

// The analog output stage of the console rolls the highs off; a first-order low-pass at 8 kHz.
const OUTPUT_LOWPASS_HZ = 8000;

// A Mega Drive sound driver runs once per video frame (NTSC: 60 Hz).
const FRAME_HZ = 60;

// The noise channel's volume: 16 steps of 2 dB, the last one off.
const PSG_STEP_DB = 2;
const PSG_LOUDEST_OFF_STEP = 15;

// The longest a voice's release may ring, in seconds.
const LONGEST_TAIL_SECONDS = 0.8;

// The cut at the end of a drum hit that a later hit stops, in seconds: it avoids a click.
const HIT_FADE_SECONDS = 0.002;

/**
 * The bits of the SN76489's noise register, one per step of its clock.
 *
 * The register is 16 bits wide and starts at 0x8000. Each step the output is bit 0, the register
 * shifts right, and the bit that enters at the top is the feedback: in white-noise mode the XOR
 * of bits 0 and 3, which gives a pseudo-random stream that repeats after 57,337 steps; in
 * periodic mode just bit 0, so the single set bit circulates and the output repeats every 16
 * steps, a buzz at the clock rate divided by 16.
 * @param {number} count how many steps
 * @param {boolean} periodic true for the 16-step periodic mode
 * @returns {Uint8Array} `count` bits
 * @example
 * psgNoiseBits(4, true); // [0, 0, 0, 0]: the set bit is still at the top
 * psgNoiseBits(17, true)[15]; // 1: it arrives at bit 0 after 15 steps, and again after 16 more
 */
export function psgNoiseBits(count, periodic) {
  const bits = new Uint8Array(count);
  let register = 0x8000;
  for (let i = 0; i < count; i++) {
    bits[i] = register & 1;
    const feedback = periodic ? register & 1 : (register ^ (register >> 3)) & 1;
    register = (register >> 1) | (feedback << 15);
  }
  return bits;
}

/**
 * How many 2 dB volume steps a MIDI velocity is below the noise channel's loudest level: the
 * attenuation of an amplitude ratio in 2 dB steps, at most 14 (15 would be off).
 * @param {number} velocity 1 to 127
 * @returns {number} 0 for velocity 127
 * @example
 * psgVolumeStep(127); // 0
 * psgVolumeStep(64); // 3: about 6 dB down
 */
export function psgVolumeStep(velocity) {
  const dB = 20 * Math.log10(127 / Math.max(1, velocity));
  return Math.min(PSG_LOUDEST_OFF_STEP - 1, Math.round(dB / PSG_STEP_DB));
}

/**
 * The amplitude of a volume step of the noise channel: 2 dB less for each step.
 * @param {number} step 0 (loudest) to 15 (off)
 * @returns {number}
 * @example
 * psgGain(5); // 10 ** (-10 / 20) ≈ 0.316
 */
export function psgGain(step) {
  return step >= PSG_LOUDEST_OFF_STEP ? 0 : 10 ** ((-PSG_STEP_DB * step) / 20);
}

/**
 * A burst of the noise channel as samples: the register's bits held for the length of each step
 * (±1), lowered by the driver one or more volume steps per frame, then filtered.
 * @param {PsgBurst} burst
 * @param {number} velocity MIDI velocity
 * @param {number} nSamples
 * @param {number} sampleRate
 * @returns {Float64Array}
 */
export function psgBurst(burst, velocity, nSamples, sampleRate) {
  const ticks = Math.ceil((nSamples / sampleRate) * burst.shiftHz) + 1;
  const bits = psgNoiseBits(ticks, burst.periodic);
  const samples = new Float64Array(nSamples);
  const startStep = psgVolumeStep(velocity);
  for (let i = 0; i < nSamples; i++) {
    const t = i / sampleRate;
    const step = startStep + Math.floor(t * FRAME_HZ) * burst.stepsPerFrame;
    samples[i] = psgGain(step) * (bits[Math.floor(t * burst.shiftHz)] ? 1 : -1);
  }
  lowpass(samples, burst.lowpassHz, sampleRate);
  return samples;
}

/**
 * Add `samples × gain` into `target` from `first` on, dropping what runs past its end.
 * @param {Float64Array} target
 * @param {Float64Array} samples
 * @param {number} first
 * @param {number} gain
 */
function addInto(target, samples, first, gain) {
  const n = Math.min(samples.length, target.length - first);
  for (let i = 0; i < n; i++) target[first + i] += gain * samples[i];
}

/**
 * Play the arrangement with the Mega Drive's voices, one stem per channel, before the peak
 * scale.
 * @param {import("./chip-synth.js").ChipArrangement} arrangement
 * @param {number} sampleRate
 * @returns {Record<ChannelName, Float64Array>} four stems of `renderLength(arrangement, sampleRate)`
 *   samples, on one scale with the channel levels inside them
 * @example
 * renderMegaDriveStems({ tempoBpm: 120, channels: { TR: [{ pitch: 40, onset: 0, duration: 1, velocity: 100 }] } }, 44100).TR.length; // 28665
 */
export function renderMegaDriveStems(arrangement, sampleRate) {
  const length = renderLength(arrangement, sampleRate);
  const secondsPerBeat = 60 / arrangement.tempoBpm;
  /** @type {Record<ChannelName, Float64Array>} */
  const stems = {
    P1: new Float64Array(length),
    P2: new Float64Array(length),
    TR: new Float64Array(length),
    NO: new Float64Array(length),
  };
  // An arrangement repeats itself (arpeggios, bass patterns, refrains), and a note's sound does
  // not depend on when it starts, so each distinct note is rendered once and added wherever it
  // occurs. This cuts the work several times over for a typical song.
  /** @type {Map<string, Float64Array>} */
  const rendered = new Map();
  for (const channel of /** @type {const} */ (["P1", "P2", "TR"])) {
    const patch = MEGADRIVE_PATCHES[channel];
    const played = sounding(arrangement.channels[channel] ?? [], secondsPerBeat);
    played.forEach(({ start, end, note }, index) => {
      const heldSamples = Math.round((end - start) * sampleRate);
      if (heldSamples <= 0) return;
      // A voice plays one note at a time: the release may ring until the next note starts
      const gapSamples = index + 1 < played.length ? Math.max(0, Math.round((played[index + 1].start - end) * sampleRate)) : Infinity;
      const tailSamples = Math.min(gapSamples, Math.round(LONGEST_TAIL_SECONDS * sampleRate));
      const key = `${channel}|${note.pitch}|${heldSamples}|${note.velocity}|${tailSamples}`;
      let samples = rendered.get(key);
      if (!samples) {
        const note1 = { frequency: noteFrequency(note.pitch), seconds: heldSamples / sampleRate, velocity: note.velocity, maxTail: tailSamples / sampleRate };
        samples = renderFmNote(patch, note1, sampleRate);
        rendered.set(key, samples);
      }
      addInto(stems[channel], samples, Math.round(start * sampleRate), STEM_GAINS[channel]);
    });
  }
  /** @type {Map<string, Float64Array>} */
  const hits = new Map();
  for (const { start, end, note } of sounding(arrangement.channels.NO ?? [], secondsPerBeat)) {
    const drum = MEGADRIVE_DRUMS[note.pitch] ?? MEGADRIVE_DRUMS[38];
    const available = Math.max(Math.round((end - start) * sampleRate), Math.round(0.01 * sampleRate));
    const key = `${note.pitch in MEGADRIVE_DRUMS ? note.pitch : 38}|${note.velocity}|${available}`;
    let hit = hits.get(key);
    if (!hit) {
      hit = drumHit(drum, note.velocity, available, sampleRate);
      hits.set(key, hit);
    }
    addInto(stems.NO, hit, Math.round(start * sampleRate), 1);
  }
  for (const stem of Object.values(stems)) lowpass(stem, OUTPUT_LOWPASS_HZ, sampleRate);
  stems.NO.forEach((value, i) => (stems.NO[i] = value * STEM_GAINS.NO));
  return stems;
}

/**
 * One drum hit as samples: its FM voice and its noise burst, cut after `available` samples (the
 * next hit of the channel cuts it, as there is one drum channel).
 * @param {Readonly<{fm?: FmDrum, psg?: PsgBurst}>} drum
 * @param {number} velocity
 * @param {number} available samples until the next hit
 * @param {number} sampleRate
 * @returns {Float64Array}
 */
function drumHit(drum, velocity, available, sampleRate) {
  const hit = new Float64Array(Math.round(Math.max(drum.fm?.seconds ?? 0, 0.12) * sampleRate));
  if (drum.fm) {
    const { patch, hz, seconds, gain } = drum.fm;
    const rendered = renderFmNote(patch, { frequency: hz, seconds, velocity }, sampleRate);
    for (let i = 0; i < Math.min(rendered.length, hit.length); i++) hit[i] += gain * rendered[i];
  }
  if (drum.psg) {
    const burst = psgBurst(drum.psg, velocity, Math.min(hit.length, Math.round(0.25 * sampleRate)), sampleRate);
    for (let i = 0; i < burst.length; i++) hit[i] += drum.psg.gain * burst[i];
  }
  const n = Math.min(hit.length, available);
  const fade = Math.max(1, Math.round(HIT_FADE_SECONDS * sampleRate));
  const cut = new Float64Array(n);
  for (let i = 0; i < n; i++) cut[i] = hit[i] * Math.min(1, (n - i) / fade);
  return cut;
}
