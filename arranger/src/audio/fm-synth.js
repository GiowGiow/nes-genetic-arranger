// @ts-check
// A four-operator FM voice, after the Yamaha YM2612 of the Sega Mega Drive (Genesis).
//
// FM (frequency modulation) synthesis makes rich sounds out of sine waves. An operator is a sine
// oscillator with its own envelope. A carrier is an operator you hear; a modulator is one that
// you do not: its output is added to the phase of another operator, which bends that operator's
// sine back and forth. The faster and deeper the bending, the more partials (overtones) the
// carrier gets: a modulator at the same frequency as its carrier gives a harmonic series like a
// sawtooth; one at a non-integer multiple gives bell-like, inharmonic partials; the depth, the
// modulation index, is set by the modulator's level, so an envelope on the modulator makes the
// sound bright at the attack and mellow as it fades, the signature of FM brass and electric
// pianos. (J. Chowning, "The synthesis of complex audio spectra by means of frequency
// modulation", JAES 1973.)
//
// The YM2612 gives each of its 6 voices four operators and eight ways to connect them, the
// algorithms (`ALGORITHMS`): from a serial chain 1 > 2 > 3 > 4, whose single carrier is the
// richest, to four parallel carriers, which is a four-partial additive organ. Operator 1 can
// also modulate itself, feedback: it adds its last two outputs to its own phase, which turns its
// sine into a sawtooth-like wave without any other operator.
//
// Each operator has the chip's envelope shape (YM2612 manual, "EG"), kept in dB because the ear
// hears loudness as ratios: an attack that rises fast and slows near the top, a first decay at a
// steady dB per second down to a sustain level, a second decay from there, and a release after
// the key goes up. Rates are given in dB per second (or seconds, for the attack) instead of the
// chip's 5-bit rate codes, which keeps the numbers readable. The chip's 0.75 dB total level
// steps, 10-bit tables and 53 kHz rate are not copied: this is an impression of the chip made
// with Math.sin, not a cycle-exact emulation. Two small additions that a Mega Drive sound driver
// does in software are built in: a delayed vibrato (the chip has an LFO for it) and a pitch
// envelope, a pitch that falls onto the note, which is how FM kick drums get their thump.
//
// The code is pure and deterministic, and fast enough for a three-minute song: the envelope and
// the pitch are computed every 32 samples and interpolated between, the sine comes from a
// table with linear interpolation (8,192 entries, an error under 1e-7, far below the 16 bits of
// a sound card), and silent operators cost nothing.

/**
 * One operator's settings. Make one with `fmOperator`.
 * @typedef {object} FmOperator
 * @property {number} multiple frequency as a multiple of the note's (0.5, 1, 2, ..., 15)
 * @property {number} detuneCents small pitch offset of this operator, in cents
 * @property {number} totalLevel attenuation in dB: 0 is the loudest, 96 is silent. For a modulator
 *   this is the modulation index; for a carrier it is the level
 * @property {number} attack seconds for the attenuation to fall from 96 dB to 0
 * @property {number} decay1Rate dB per second of the first decay (0 holds the level)
 * @property {number} sustainLevel attenuation in dB where the first decay hands over to the second
 * @property {number} decay2Rate dB per second of the second decay (0 holds the level)
 * @property {number} releaseRate dB per second after the key goes up
 */

/**
 * A whole voice.
 * @typedef {object} FmPatch
 * @property {number} algorithm 0 to 7, an index of ALGORITHMS
 * @property {number} feedback 0 to 7, an index of FEEDBACK_RADIANS: operator 1's feedback
 * @property {FmOperator[]} operators four operators
 * @property {{hz: number, cents: number, delay: number}} [vibrato] pitch wobble of `hz`, peaking
 *   at ±`cents`, which starts `delay` seconds after the note
 * @property {{semitones: number, seconds: number}} [pitchEnvelope] the note starts `semitones`
 *   high and falls to its pitch, exponentially, with a time constant of `seconds`
 * @property {{fromHz: number, dbPerOctave: number}} [brightnessTracking] the modulators are
 *   lowered by `dbPerOctave` for each octave the note lies above `fromHz`. Without it a high
 *   note has partials that fall high in the spectrum, and sound thin and harsh; sound drivers
 *   lower the modulator levels of high notes by hand (level scaling) for the same reason
 */

/**
 * Attenuation at which the chip's envelope counts as silence, in dB (its 10-bit scale covers 96 dB).
 * @example
 * MAX_ATTENUATION_DB; // 96
 */
export const MAX_ATTENUATION_DB = 96;

/**
 * How far a modulator at full level bends its carrier's phase, in radians: the modulation index
 * at 0 dB, about two full turns each way. Each dB of attenuation lowers it proportionally.
 * @example
 * MODULATION_RADIANS; // 4π ≈ 12.57
 */
export const MODULATION_RADIANS = 4 * Math.PI;

/**
 * Operator 1's feedback, in radians of phase per unit of its own output, for settings 0 to 7:
 * none, π/16, π/8, π/4, π/2, π, 2π and 4π (the YM2612 manual's table).
 * @type {readonly number[]}
 * @example
 * FEEDBACK_RADIANS[5]; // π: a strong, almost sawtooth wave
 */
export const FEEDBACK_RADIANS = Object.freeze([0, ...Array.from({ length: 7 }, (_, step) => (Math.PI / 16) * 2 ** step)]);

/**
 * The eight algorithms: for each operator (numbered from 0), which operators modulate it, and
 * which operators are carriers, that is, heard. Operators are computed in order, and an operator
 * is only ever fed by lower-numbered ones.
 * @type {readonly Readonly<{inputs: ReadonlyArray<readonly number[]>, carriers: readonly number[]}>[]}
 * @example
 * ALGORITHMS[0]; // { inputs: [[], [0], [1], [2]], carriers: [3] }: 1 > 2 > 3 > 4
 * ALGORITHMS[4].carriers; // [1, 3]: two pairs, 1 > 2 and 3 > 4, added
 */
export const ALGORITHMS = Object.freeze([
  { inputs: [[], [0], [1], [2]], carriers: [3] }, // 1 > 2 > 3 > 4
  { inputs: [[], [], [0, 1], [2]], carriers: [3] }, // (1 + 2) > 3 > 4
  { inputs: [[], [], [1], [0, 2]], carriers: [3] }, // (1 + (2 > 3)) > 4
  { inputs: [[], [0], [], [1, 2]], carriers: [3] }, // ((1 > 2) + 3) > 4
  { inputs: [[], [0], [], [2]], carriers: [1, 3] }, // (1 > 2) + (3 > 4)
  { inputs: [[], [0], [0], [0]], carriers: [1, 2, 3] }, // 1 > (2, 3, 4)
  { inputs: [[], [0], [], []], carriers: [1, 2, 3] }, // (1 > 2) + 3 + 4
  { inputs: [[], [], [], []], carriers: [0, 1, 2, 3] }, // 1 + 2 + 3 + 4
]);

// Samples between recomputations of the envelopes and the pitch; the values between are
// interpolated. 32 samples is 1.4 kHz at 44.1 kHz, far faster than any envelope moves.
const CONTROL_BLOCK = 32;

// The longest release tail a note is given, in seconds, however slow the release.
const LONGEST_TAIL_SECONDS = 0.8;

// A release tail is over when its carriers are this far down, in dB: nobody hears it any more.
const AUDIBLE_ATTENUATION_DB = 72;

// The fade at the end of a note or tail that is cut off while still audible, in seconds.
const FADE_OUT_SECONDS = 0.002;

const TWO_PI = 2 * Math.PI;
const INVERSE_TWO_PI = 1 / TWO_PI;

// One period of a sine, plus one entry to close it, so that interpolation never reads past the end.
const SINE_SIZE = 8192;
const SINE_TABLE = Float64Array.from({ length: SINE_SIZE + 1 }, (_, i) => Math.sin((TWO_PI * i) / SINE_SIZE));

/**
 * The sine of a phase given in cycles (any real number), by table lookup with linear
 * interpolation.
 * @param {number} cycles 1 is a full turn
 * @returns {number}
 */
function sineOfCycles(cycles) {
  const position = (cycles - Math.floor(cycles)) * SINE_SIZE;
  const index = position | 0;
  const fraction = position - index;
  return SINE_TABLE[index] + (SINE_TABLE[index + 1] - SINE_TABLE[index]) * fraction;
}

// The attack falls from 96 dB to ~0.1 dB, a factor of 960 on a log scale.
const ATTACK_RANGE = MAX_ATTENUATION_DB / 0.1;

/**
 * An operator, with the settings you leave out filled in: multiple 1, no detune, full level, no
 * attack, no decay (a flat, organ-like envelope) and a release of 120 dB per second.
 * @param {Partial<FmOperator>} [settings]
 * @returns {FmOperator} a frozen operator
 * @example
 * fmOperator({ multiple: 2, totalLevel: 20 }); // an octave above the note, 20 dB down
 */
export function fmOperator(settings = {}) {
  return Object.freeze({
    multiple: 1,
    detuneCents: 0,
    totalLevel: 0,
    attack: 0,
    decay1Rate: 0,
    sustainLevel: MAX_ATTENUATION_DB,
    decay2Rate: 0,
    releaseRate: 120,
    ...settings,
  });
}

/**
 * The envelope alone, without the operator's total level: how many dB down the operator is
 * at time `t` while the key is held.
 * @param {FmOperator} operator
 * @param {number} t seconds since the key went down
 * @returns {number}
 */
function heldAttenuation(operator, t) {
  if (t < operator.attack) {
    // Attack: the dB fall by a constant factor per second, so the amplitude rises fast, then
    // slows as it nears full level, as on the chip.
    return MAX_ATTENUATION_DB * ATTACK_RANGE ** (-t / operator.attack);
  }
  const sinceAttack = t - operator.attack;
  if (operator.decay1Rate <= 0) return 0;
  const toSustain = operator.sustainLevel / operator.decay1Rate;
  if (sinceAttack <= toSustain) return operator.decay1Rate * sinceAttack;
  return operator.sustainLevel + operator.decay2Rate * (sinceAttack - toSustain);
}

/**
 * How many dB down an operator is at time `t`: its envelope plus its total level, at most 96.
 * @param {FmOperator} operator
 * @param {number} t seconds since the key went down
 * @param {number} [releaseAt] when the key goes up, in seconds (default never)
 * @returns {number} dB of attenuation, 0 to 96
 * @example
 * attenuationDb(fmOperator({ decay1Rate: 20 }), 0.5); // 10: a steady 20 dB per second
 */
export function attenuationDb(operator, t, releaseAt = Infinity) {
  let attenuation = heldAttenuation(operator, Math.min(t, releaseAt));
  if (t > releaseAt) attenuation += operator.releaseRate * (t - releaseAt);
  return Math.min(MAX_ATTENUATION_DB, operator.totalLevel + attenuation);
}

/**
 * An operator's amplitude at time `t`, from 1 (full) to 0 (silent): 10^(-dB / 20).
 * @param {FmOperator} operator
 * @param {number} t seconds since the key went down
 * @param {number} [releaseAt] when the key goes up, in seconds (default never)
 * @returns {number}
 * @example
 * envelopeGain(fmOperator({ totalLevel: 20 }), 1); // 0.1
 */
export function envelopeGain(operator, t, releaseAt = Infinity) {
  const attenuation = attenuationDb(operator, t, releaseAt);
  return attenuation >= MAX_ATTENUATION_DB ? 0 : 10 ** (-attenuation / 20);
}

/**
 * Render one note of a patch: the sum of its carriers, at amplitude 1 for velocity 127 and full
 * level, followed by the release tail.
 *
 * The tail lasts until the carriers have fallen 72 dB, which the ear no longer hears, but never
 * longer than `maxTail`: a channel of the arrangement plays one note at a time, as a chip voice
 * does, so the player gives the time until the channel's next note. A tail that is cut off is
 * faded out over 2 ms, and so is a note that is cut with no tail, to avoid a click.
 *
 * @param {FmPatch} patch
 * @param {{frequency: number, seconds: number, velocity?: number, maxTail?: number}} note the pitch
 *   in Hz, how long the key is held, the MIDI velocity (default 127), which scales the carriers,
 *   and the longest tail allowed in seconds (default 0.8)
 * @param {number} sampleRate
 * @returns {Float64Array} `seconds × sampleRate` samples plus the tail
 * @example
 * const organ = { algorithm: 7, feedback: 0, operators: [fmOperator(), ...Array(3).fill(fmOperator({ totalLevel: 96 }))] };
 * renderFmNote(organ, { frequency: 440, seconds: 1 }, 44100)[100]; // sin(2π · 440 · 100 / 44100) ≈ 0.5
 */
export function renderFmNote(patch, note, sampleRate) {
  const { inputs, carriers } = ALGORITHMS[patch.algorithm];
  const operators = trackedOperators(patch, note.frequency);
  const seconds = Math.max(0, note.seconds);
  const loudness = (note.velocity ?? 127) / 127;
  const heldSamples = Math.round(seconds * sampleRate);

  // The release tail lasts until the loudest carrier is 72 dB down, but never past the limit.
  let neededTail = 0;
  for (const carrier of carriers) {
    const operator = operators[carrier];
    const remaining = AUDIBLE_ATTENUATION_DB - attenuationDb(operator, seconds);
    if (remaining > 0) neededTail = Math.max(neededTail, remaining / Math.max(operator.releaseRate, 1e-9));
  }
  const tail = Math.min(neededTail, note.maxTail ?? LONGEST_TAIL_SECONDS);
  const length = heldSamples + Math.ceil(tail * sampleRate);
  const output = new Float64Array(length);

  // The connections as 0/1 weights, so that the four operators below can be written out one by
  // one with no branches: w21 is 1 when operator 1 modulates operator 2, and so on; c0..c3 are 1
  // for the carriers. Written this way the loop runs in registers, about twice as fast as a
  // generic loop over operators, which matters for a three-minute song.
  const weight = (/** @type {number} */ target, /** @type {number} */ source) => (inputs[target].includes(source) ? MODULATION_RADIANS * INVERSE_TWO_PI : 0);
  const w10 = weight(1, 0);
  const w20 = weight(2, 0);
  const w21 = weight(2, 1);
  const w30 = weight(3, 0);
  const w31 = weight(3, 1);
  const w32 = weight(3, 2);
  const c = Float64Array.from({ length: 4 }, (_, k) => (carriers.includes(k) ? loudness : 0));
  const detune = Float64Array.from(operators, (operator) => 2 ** (operator.detuneCents / 1200));
  const feedback = FEEDBACK_RADIANS[patch.feedback] * INVERSE_TWO_PI * 0.5;

  // Phases in cycles, outputs, and the gains and phase steps of the current block
  let p0 = 0, p1 = 0, p2 = 0, p3 = 0;
  let o0 = 0, o1 = 0, o2 = 0, o3 = 0;
  let previous = 0; // operator 1's output one sample ago
  const g = new Float64Array(8); // gains at the start (0..3) and end (4..7) of the block
  const s = new Float64Array(4);

  for (let first = 0; first < length; first += CONTROL_BLOCK) {
    const t0 = first / sampleRate;
    const t1 = (first + CONTROL_BLOCK) / sampleRate;
    const pitch = pitchFactor(patch, (t0 + t1) / 2);
    for (let k = 0; k < 4; k++) {
      // The end of the last block is the start of this one
      g[k] = first === 0 ? envelopeGain(operators[k], t0, seconds) : g[4 + k];
      g[4 + k] = envelopeGain(operators[k], t1, seconds);
      s[k] = (note.frequency * pitch * operators[k].multiple * detune[k]) / sampleRate;
    }
    const last = Math.min(length, first + CONTROL_BLOCK);
    const slope0 = (g[4] - g[0]) / CONTROL_BLOCK;
    const slope1 = (g[5] - g[1]) / CONTROL_BLOCK;
    const slope2 = (g[6] - g[2]) / CONTROL_BLOCK;
    const slope3 = (g[7] - g[3]) / CONTROL_BLOCK;
    for (let i = first; i < last; i++) {
      const along = i - first;
      // Operator 1 feeds back the average of its last two outputs; the others take their inputs
      const g0 = g[0] + slope0 * along;
      const q0 = o0; // one sample ago, for the next feedback
      o0 = g0 === 0 ? 0 : g0 * sineOfCycles(p0 + feedback * (o0 + previous));
      previous = q0;
      const g1 = g[1] + slope1 * along;
      o1 = g1 === 0 ? 0 : g1 * sineOfCycles(p1 + w10 * o0);
      const g2 = g[2] + slope2 * along;
      o2 = g2 === 0 ? 0 : g2 * sineOfCycles(p2 + w20 * o0 + w21 * o1);
      const g3 = g[3] + slope3 * along;
      o3 = g3 === 0 ? 0 : g3 * sineOfCycles(p3 + w30 * o0 + w31 * o1 + w32 * o2);
      output[i] = c[0] * o0 + c[1] * o1 + c[2] * o2 + c[3] * o3;
      p0 += s[0];
      p1 += s[1];
      p2 += s[2];
      p3 += s[3];
    }
  }
  // A note or tail that ends while it is still audible gets a short fade out
  const fade = Math.min(length, Math.round(FADE_OUT_SECONDS * sampleRate));
  if (tail < neededTail || (tail === 0 && attenuationDb(operators[carriers[0]], seconds) < AUDIBLE_ATTENUATION_DB)) {
    for (let i = 0; i < fade; i++) output[length - 1 - i] *= i / fade;
  }
  return output;
}

/**
 * The patch's operators for a note of this frequency: with brightness tracking, the modulators
 * (the operators that are not carriers) are lowered the higher the note is.
 * @param {FmPatch} patch
 * @param {number} frequency
 * @returns {FmOperator[]}
 */
function trackedOperators(patch, frequency) {
  const tracking = patch.brightnessTracking;
  if (!tracking || frequency <= tracking.fromHz) return patch.operators;
  const lowering = tracking.dbPerOctave * Math.log2(frequency / tracking.fromHz);
  const { carriers } = ALGORITHMS[patch.algorithm];
  return patch.operators.map((operator, k) => (carriers.includes(k) ? operator : { ...operator, totalLevel: Math.min(MAX_ATTENUATION_DB, operator.totalLevel + lowering) }));
}

/**
 * The factor the note's frequency is multiplied by at time `t`: the delayed vibrato and the
 * falling pitch envelope.
 * @param {FmPatch} patch
 * @param {number} t seconds since the key went down
 * @returns {number}
 */
function pitchFactor(patch, t) {
  let semitones = 0;
  const { vibrato, pitchEnvelope } = patch;
  if (vibrato && t > vibrato.delay) {
    semitones += (vibrato.cents / 100) * Math.sin(2 * Math.PI * vibrato.hz * (t - vibrato.delay));
  }
  if (pitchEnvelope) semitones += pitchEnvelope.semitones * Math.exp(-t / pitchEnvelope.seconds);
  return semitones === 0 ? 1 : 2 ** (semitones / 12);
}
