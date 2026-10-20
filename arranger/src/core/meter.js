// @ts-check
// Meters: how long a bar is, where its beats fall and which beats are strong (port of
// src/leadsheet/meter.py).
//
// A meter n/d (time signature) holds n notes of the denominator's value d (4 is a quarter note, 8
// an eighth). The listener does not hear the bar as an even row of notes but as a few *beats*,
// the pulse a foot taps, and some beats are *strong*. Every texture of the arranger leans on that
// pulse: the bass plays the root on a strong beat, the drums kick on strong beats and hit the
// snare on weak ones.
//
// The arranger does not look the beats up in a table: it derives them by one rule, the way
// musicians count, so every meter with d = 1, 2, 4, 8 or 16 and n from 1 to 32 can be arranged.
// The rule sorts the meters into four families:
// - Compound meters, whose numerator is a multiple of 3 from 6 on (6/8, 9/8, 12/8, 6/4), group
//   their notes in threes, so a beat is a dotted note: 6/8 has two beats of 1.5 quarters each,
//   and a jig is felt "in two".
// - Irregular fast meters, of eighths or sixteenths, with 5 notes or more and not compound (5/8,
//   7/8, 8/8, 11/8), group their notes in twos, with a last group of three when n is odd: 7/8 is
//   felt 2 + 2 + 3, so its three beats last 1, 1 and 1.5 quarters.
// - Simple meters, all the others (2/2, 3/4, 4/4, 5/4, 7/4, 3/2, 3/8), count beats of the
//   denominator note: 3/4 has three quarter-note beats.
// - Additive meters, which ABC writes as 2+2+3/8 or (3+3+2)/8, state their own groups: one beat
//   per group, so a tune can ask for another grouping than the rule's.
//
// The strong beats split the bar in two halves: beat 1, and the first beat of the second half
// when the bar has four beats or more. With an odd number of beats the first half is the longer
// one, so 5/4 is felt 3 + 2 (strong beats 1 and 4). A bar of up to three beats has only one
// strong beat. The rule gives exactly the nine meters that spec 003 listed by hand
// (`COMMON_METERS`).
//
// All lengths are in quarter-note beats, the unit of the whole method, so a 6/8 bar lasts 3.0 and
// a 7/8 bar 3.5. The drums and the score tables work on a grid of sixteenth notes, and a
// denominator of 32 or more would put beats off that grid, so those meters stay unsupported.
//
// A meter is a frozen object, and there is exactly one object per meter text, so two bars in the
// same meter hold the same object and compare with ===.

/**
 * A time signature, with its beats and strong beats. `String(meter)` gives "3/4", or "2+2+3/8"
 * for an additive meter.
 * @typedef {object} Meter
 * @property {number} numerator notes of the denominator's value per bar, as written (1 to 32).
 * @property {number} denominator the note value of the numerator: 1, 2, 4, 8 or 16.
 * @property {readonly number[] | null} grouping the groups of an additive meter as written
 *   (2+2+3/8 is [2, 2, 3]), one beat each; null for a plain meter, whose beats follow the rule.
 * @property {number} barBeats the bar length in quarter notes: numerator × 4 / denominator.
 * @property {readonly number[]} beats the length of each beat in quarter notes; they add up to
 *   barBeats.
 * @property {readonly number[]} strong indices into beats of the strong beats; beat 0 is always
 *   strong.
 * @property {number} steps sixteenth-note steps in one bar, the grid of the drums and of the
 *   score tables.
 * @property {() => string} toString the meter as written, for example "3/4" (inherited, so a
 *   structured clone, as the worker receives it, holds only the data fields).
 */

/**
 * Anything placed in a meter, such as a lead-sheet bar.
 * @typedef {{meter: Meter}} HasMeter
 */

/** The note values a meter may count: whole, half, quarter, eighth and sixteenth. */
const DENOMINATORS = [1, 2, 4, 8, 16];
const MAX_NUMERATOR = 32;

/**
 * What the error of an unsupported meter says is accepted (the same text as the Python reader).
 * @type {string}
 */
export const SUPPORTED_RANGE =
  "n/d with n from 1 to 32 and d = 1, 2, 4, 8 or 16, additive meters such as 2+2+3/8, C and C|";

// Names that ABC writes for two meters: "C" (common time) and "C|" (cut time).
/** @type {Readonly<Record<string, string>>} */
const SYMBOLS = Object.freeze({ C: "4/4", "C|": "2/2" });

// "3/4", an additive "2+2+3/8", or an additive in parentheses "(3+3+2)/8".
const METER_TEXT = /^(?:\((\d+(?:\+\d+)+)\)|(\d+(?:\+\d+)*))\/(\d+)$/;

/** Shared behavior of the meter objects: `String(meter)` gives the meter as written. */
const METER_PROTOTYPE = Object.freeze({
  /** @this {{numerator: number, denominator: number, grouping: readonly number[] | null}} */
  toString() {
    return meterText(this);
  },
});

/** One shared object per meter text. @type {Map<string, Meter>} */
const INTERNED = new Map();

/**
 * The error for a meter outside the supported range, naming the bar when it is known.
 * @param {string} text the meter as written.
 * @param {number | undefined} barNumber the bar (counted from 1) where it appears.
 * @returns {Error}
 */
function unsupported(text, barNumber) {
  const where = barNumber !== undefined ? `bar ${barNumber}: ` : "";
  return new Error(`${where}the meter ${text} is not supported; supported meters: ${SUPPORTED_RANGE}`);
}

/**
 * @param {number} numerator
 * @param {number} denominator
 * @returns {boolean} whether n/d is inside the supported range.
 */
function inRange(numerator, denominator) {
  return (
    DENOMINATORS.includes(denominator) &&
    Number.isInteger(numerator) &&
    numerator >= 1 &&
    numerator <= MAX_NUMERATOR
  );
}

/**
 * How the bar's notes of the denominator's value gather into beats, by the rule of the module.
 *
 * Each number is one beat, counted in denominator notes: compound meters group them in threes,
 * irregular fast meters in twos with a last three when the numerator is odd, and simple meters
 * count every note as a beat.
 *
 * @param {number} numerator notes per bar.
 * @param {number} denominator the note value of the numerator.
 * @returns {number[]} the length of each beat, in denominator notes.
 * @example
 * beatGrouping(6, 8); // → [3, 3]
 * beatGrouping(7, 8); // → [2, 2, 3]
 * beatGrouping(11, 8); // → [2, 2, 2, 2, 3]
 * beatGrouping(3, 4); // → [1, 1, 1]
 */
export function beatGrouping(numerator, denominator) {
  if (numerator % 3 === 0 && numerator >= 6) {
    // Compound: 6/8, 9/8, 12/8, 6/4.
    return Array(numerator / 3).fill(3);
  }
  if (denominator >= 8 && numerator >= 5) {
    // Irregular fast: 5/8 = 2+3, 8/8 = 2+2+2+2.
    if (numerator % 2 === 1) return [...Array((numerator - 3) / 2).fill(2), 3];
    return Array(numerator / 2).fill(2);
  }
  return Array(numerator).fill(1); // Simple: 3/4, 5/4, 3/2, 3/8.
}

/**
 * The indices of the strong beats of a bar of `beatCount` beats.
 *
 * Beat 0 always; from four beats on, also the first beat of the second half, which starts after
 * the longer half when the count is odd (5 beats are felt 3 + 2).
 *
 * @param {number} beatCount beats in the bar.
 * @returns {number[]} the strong beats' indices, starting at 0.
 * @example
 * strongBeats(3); // → [0]
 * strongBeats(4); // → [0, 2]
 * strongBeats(5); // → [0, 3]
 * strongBeats(7); // → [0, 4]
 */
export function strongBeats(beatCount) {
  return beatCount < 4 ? [0] : [0, Math.floor((beatCount + 1) / 2)];
}

/**
 * The meter as written: numerator, slash, denominator; an additive meter writes its groups
 * joined with plus signs in place of the numerator. `String(meter)` gives the same text.
 *
 * @param {{numerator: number, denominator: number, grouping?: readonly number[] | null}} meter a
 *   meter, or the data fields of one (a structured clone of it).
 * @returns {string} for example "6/8" or "2+2+3/8".
 * @example
 * meterText(makeMeter(6, 8)); // → "6/8"
 * meterText(makeMeter(7, 8, [2, 2, 3])); // → "2+2+3/8"
 * String(makeMeter(6, 8)); // → "6/8"
 */
export function meterText(meter) {
  const top = meter.grouping ? meter.grouping.join("+") : String(meter.numerator);
  return `${top}/${meter.denominator}`;
}

/**
 * The meter numerator/denominator, as the one shared object of that meter.
 *
 * @param {number} numerator notes of the denominator's value per bar, as written (1 to 32).
 * @param {number} denominator the note value of the numerator: 1, 2, 4, 8 or 16.
 * @param {readonly number[] | null} [grouping] the groups of an additive meter, adding up to
 *   `numerator`, two or more; omitted for a plain meter, whose beats follow the rule.
 * @returns {Meter} the meter; the same object on every call.
 * @throws {Error} for a meter outside the supported range, or a grouping that does not add up.
 * @example
 * const waltz = makeMeter(3, 4);
 * [waltz.barBeats, waltz.beats, waltz.strong, waltz.steps]; // → [3, [1, 1, 1], [0], 12]
 * makeMeter(6, 8).beats; // → [1.5, 1.5], two dotted-quarter beats
 * makeMeter(3, 4) === waltz; // → true
 * String(makeMeter(8, 8, [3, 3, 2])); // → "3+3+2/8", beats [1.5, 1.5, 1]
 */
export function makeMeter(numerator, denominator, grouping = null) {
  if (!inRange(numerator, denominator)) {
    throw unsupported(meterText({ numerator, denominator, grouping }), undefined);
  }
  if (
    grouping !== null &&
    !(
      grouping.length >= 2 &&
      grouping.every((group) => Number.isInteger(group) && group >= 1) &&
      grouping.reduce((sum, group) => sum + group, 0) === numerator
    )
  ) {
    throw new Error(
      `the groups ${grouping.join("+")} do not make an additive meter of ${numerator}/${denominator}: ` +
        `it needs two or more groups that add up to ${numerator}`,
    );
  }
  const text = meterText({ numerator, denominator, grouping });
  const known = INTERNED.get(text);
  if (known !== undefined) return known;

  const barBeats = (numerator * 4) / denominator;
  const beats = (grouping ?? beatGrouping(numerator, denominator)).map((notes) => (notes * 4) / denominator);
  // toString lives on the prototype: the page posts lead sheets to the worker, and a
  // structured clone cannot copy a function held by the object itself.
  const meter = /** @type {Meter} */ (
    Object.freeze(
      Object.assign(Object.create(METER_PROTOTYPE), {
        numerator,
        denominator,
        grouping: grouping === null ? null : Object.freeze([...grouping]),
        barBeats,
        beats: Object.freeze(beats),
        strong: Object.freeze(strongBeats(beats.length)),
        steps: Math.round(4 * barBeats),
      }),
    )
  );
  INTERNED.set(text, meter);
  return meter;
}

/**
 * The nine meters of spec 003, in the order 2/2, 2/4, 3/4, 4/4, 6/8, 9/8, 12/8, 5/4, 7/8. The
 * rule derives them exactly as that spec listed them.
 * @type {readonly Meter[]}
 * @example
 * COMMON_METERS.map(String); // → ["2/2", "2/4", "3/4", "4/4", "6/8", "9/8", "12/8", "5/4", "7/8"]
 */
export const COMMON_METERS = Object.freeze(
  [
    [2, 2],
    [2, 4],
    [3, 4],
    [4, 4],
    [6, 8],
    [9, 8],
    [12, 8],
    [5, 4],
    [7, 8],
  ].map(([numerator, denominator]) => makeMeter(numerator, denominator)),
);

/**
 * The 4/4 meter, also written "C" (common time). A bar without a declared meter is in 4/4.
 * @type {Meter}
 * @example
 * FOUR_FOUR === makeMeter(4, 4); // → true
 */
export const FOUR_FOUR = makeMeter(4, 4);

/**
 * Read a meter as ABC or a time signature writes it: "3/4", "2+2+3/8", "(3+3+2)/8", "C" or "C|".
 *
 * @param {string} text the meter text; spaces around it are ignored. "C" is 4/4 and "C|" is 2/2.
 * @param {number} [barNumber] the bar (counted from 1) where the meter appears, named in the
 *   error.
 * @returns {Meter} the meter.
 * @throws {Error} for a meter outside the supported range (see the module comment), or a text
 *   that is not a meter, such as ABC's free meter "none".
 * @example
 * parseMeter("C|") === makeMeter(2, 2); // → true
 * String(parseMeter("(3+3+2)/8")); // → "3+3+2/8"
 * parseMeter("3/32", 3);
 * // throws Error: bar 3: the meter 3/32 is not supported; supported meters: n/d with n from 1 to 32...
 */
export function parseMeter(text, barNumber) {
  const cleaned = text.trim();
  const match = METER_TEXT.exec(Object.hasOwn(SYMBOLS, cleaned) ? SYMBOLS[cleaned] : cleaned);
  if (match !== null) {
    const written = (match[1] ?? match[2]).split("+").map(Number);
    const denominator = Number(match[3]);
    const numerator = written.reduce((sum, group) => sum + group, 0);
    if (written.every((group) => group >= 1) && inRange(numerator, denominator)) {
      return makeMeter(numerator, denominator, written.length > 1 ? written : null);
    }
  }
  throw unsupported(cleaned, barNumber);
}

/**
 * The onset of each beat, in quarter notes from the bar start: the running sum of the beats.
 *
 * @param {Meter} meter a supported meter.
 * @returns {number[]} one onset per beat, starting at 0.
 * @example
 * beatOnsets(makeMeter(7, 8)); // → [0, 1, 2]
 */
export function beatOnsets(meter) {
  const onsets = [0.0];
  for (const beat of meter.beats.slice(0, -1)) {
    onsets.push(onsets[onsets.length - 1] + beat);
  }
  return onsets;
}

/**
 * The onsets of the strong beats, in quarter notes from the bar start.
 *
 * @param {Meter} meter a supported meter.
 * @returns {number[]} one onset per strong beat, starting at 0.
 * @example
 * strongOnsets(FOUR_FOUR); // → [0, 2]
 * strongOnsets(makeMeter(5, 4)); // → [0, 3]
 */
export function strongOnsets(meter) {
  const onsets = beatOnsets(meter);
  return meter.strong.map((index) => onsets[index]);
}

/**
 * The [onset, length] spans from each strong beat to the next one or to the bar end.
 *
 * These are the stretches over which the MIDI reader decides one chord: half bars in 4/4,
 * 3 + 2 beats in 5/4, the whole bar in 3/4.
 *
 * @param {Meter} meter a supported meter.
 * @returns {[number, number][]} one [onset, length] pair per strong beat, in quarter notes.
 * @example
 * groups(FOUR_FOUR); // → [[0, 2], [2, 2]]
 * groups(makeMeter(3, 4)); // → [[0, 3]]
 */
export function groups(meter) {
  const starts = strongOnsets(meter);
  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : meter.barBeats;
    return [start, end - start];
  });
}

/**
 * The onset of each bar, in quarter notes from the start of the piece.
 *
 * @param {readonly HasMeter[]} bars anything with a meter, such as lead-sheet bars.
 * @returns {number[]} one onset per bar; empty for no bars.
 * @example
 * barStarts([{meter: FOUR_FOUR}, {meter: parseMeter("2/4")}, {meter: parseMeter("3/4")}]);
 * // → [0, 4, 6]
 */
export function barStarts(bars) {
  const starts = [];
  let onset = 0.0;
  for (const bar of bars) {
    starts.push(onset);
    onset += bar.meter.barBeats;
  }
  return starts;
}

/**
 * The length of the piece in quarter notes: the sum of its bar lengths.
 *
 * @param {readonly HasMeter[]} bars anything with a meter, such as lead-sheet bars.
 * @returns {number} the total length; 0 for no bars.
 * @example
 * totalBeats([{meter: parseMeter("6/8")}, {meter: parseMeter("6/8")}]); // → 6
 */
export function totalBeats(bars) {
  return bars.reduce((total, bar) => total + bar.meter.barBeats, 0.0);
}
