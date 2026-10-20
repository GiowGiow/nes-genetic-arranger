// @ts-check
/**
 * The Session client: search a folk tune site from the browser and turn one of its tunes into
 * something the arranger reads (spec 005, FR-018, research R9 and R10).
 *
 * The site's API answers browsers directly (it sends CORS `*`), so the page asks it itself and
 * the song server never touches its data. This module only builds the URLs and reshapes the
 * answers; the caller fetches. Two things make a site tune different from a lead sheet:
 *
 * - **Its ABC is only a body.** A tune's JSON has a name, a type (reel, jig, polka, …) and
 *   settings, each a key and the notes. The header is put back from them: the type gives the
 *   meter (a jig is 6/8, a reel 4/4), the unit is an eighth note, and the key is respelled for
 *   ABC ("Adorian" becomes "K:Ador"). A type that fixes no meter (a march may be 2/4, 4/4 or
 *   6/8) cannot be arranged.
 * - **Folk tunes repeat, start with a pickup and often have no chord symbols.** The lead-sheet
 *   reader expects the opposite, so these tunes take the MIDI route (R10): abcjs writes a MIDI
 *   file with the repeats played out and the chord symbols, when there are any, as an
 *   accompaniment track; the existing MIDI reduction then finds the chords. Before that, a
 *   rest is put in front of the pickup so that the first bar is full: in a 6/8 tune that
 *   starts on its last eighth, a rest of five eighths moves every later downbeat onto a bar
 *   line of the MIDI file.
 *
 * License: the site's data may not be processed by language models. The project's tests use
 * invented tunes shaped like the API, and AI agents never read the site's tunes.
 */

const API = "https://thesession.org";

/** The meter each tune type fixes (a three-two is 3/2). Other types cannot be arranged. */
export const METER_BY_TYPE = Object.freeze({
  jig: "6/8",
  reel: "4/4",
  hornpipe: "4/4",
  polka: "2/4",
  "slip jig": "9/8",
  waltz: "3/4",
  slide: "12/8",
  mazurka: "3/4",
  barndance: "4/4",
  strathspey: "4/4",
  "three-two": "3/2",
});

/** How ABC abbreviates each mode name of the API ("" for major). */
const ABC_MODES = Object.freeze({
  major: "",
  ionian: "",
  minor: "m",
  aeolian: "m",
  dorian: "dor",
  mixolydian: "mix",
  lydian: "lyd",
  phrygian: "phr",
  locrian: "loc",
});

/** The unit length written in every assembled tune: an eighth note, as the site writes them. */
const UNIT = "1/8";

/** Shortest note value a pickup rest is written in (1/64 of the unit). */
const MAX_DENOMINATOR = 64;

/**
 * @typedef {object} SessionSetting one version of a tune, as the API lists it
 * @property {number} [id]
 * @property {string} key for example "Gmajor" or "Adorian"
 * @property {string} abc the notes, without a header
 */

/**
 * @typedef {object} SessionTune a tune's JSON (`/tunes/<id>?format=json`)
 * @property {number} id
 * @property {string} name
 * @property {string} type for example "reel"
 * @property {string} [url] the tune's page
 * @property {SessionSetting[]} settings
 */

/**
 * @typedef {object} SearchResult a search result, as the song server also gives them
 *   (data model "Search result")
 * @property {string} source
 * @property {string} id
 * @property {string} title
 * @property {string} composer
 * @property {string} license
 * @property {"abc" | "midi" | "link"} format
 * @property {string} page the page to credit or open
 * @property {string} open the URL the app fetches
 * @property {string} [error] why the song cannot be arranged, as a short reason
 */

/**
 * The URL of a search, asking for JSON and 50 tunes per page.
 *
 * @param {string} query the visitor's words
 * @returns {string}
 * @example
 * searchUrl("polka & co"); // "https://thesession.org/tunes/search?q=polka%20%26%20co&format=json&perpage=50"
 */
export function searchUrl(query) {
  return `${API}/tunes/search?q=${encodeURIComponent(query)}&format=json&perpage=50`;
}

/**
 * The URL of one tune's JSON, with all its settings.
 *
 * @param {number | string} id the tune's number
 * @returns {string}
 * @example
 * tuneUrl(90501); // "https://thesession.org/tunes/90501?format=json"
 */
export function tuneUrl(id) {
  return `${API}/tunes/${id}?format=json`;
}

/**
 * The meter a tune type implies, or null when the arranger cannot use it.
 *
 * @param {string} type the tune's type, in any letter case
 * @returns {string | null} for example "6/8"
 * @example
 * meterOfType("Slip Jig"); // "9/8"
 * meterOfType("three-two"); // "3/2"
 * meterOfType("march"); // null: a march may be 2/4, 4/4 or 6/8
 */
export function meterOfType(type) {
  return METER_BY_TYPE[/** @type {keyof typeof METER_BY_TYPE} */ (type.toLowerCase())] ?? null;
}

/**
 * Respell an API key name ("Adorian") as an ABC key ("Ador").
 *
 * @param {string} keyName tonic and mode written together; "" for none
 * @returns {string} an ABC key; "C" when the name is empty or unknown
 * @example
 * abcKey("Eminor"); // "Em"
 * abcKey("Gmixolydian"); // "Gmix"
 */
export function abcKey(keyName) {
  const parts = /^([A-G][b#]?)([a-z]+)$/.exec(keyName.trim());
  if (parts === null) return "C";
  const mode = ABC_MODES[/** @type {keyof typeof ABC_MODES} */ (parts[2])];
  return mode === undefined ? "C" : parts[1] + mode;
}

/**
 * Why a tune type cannot be arranged, as a short reason, or null when it can.
 *
 * @param {string} type
 * @returns {string | null} for example "its type (march) does not fix a meter"
 */
function typeProblem(type) {
  return meterOfType(type) === null ? `its type (${type}) does not fix a meter` : null;
}

/**
 * Assemble one setting of a tune into a complete ABC tune.
 *
 * @param {SessionTune} tune the tune's JSON
 * @param {number} [settingIndex] which setting, 0 for the first
 * @returns {string} the tune, ending with a newline
 * @throws {Error} when the tune's type cannot be arranged
 * @throws {RangeError} when the tune has no such setting
 * @example
 * tuneToAbc({ id: 1, name: "Pretend Polka", type: "polka", settings: [{ key: "Gmajor", abc: "GA Bc|d2 B2|" }] });
 * // "X:1\nT:Pretend Polka\nR:polka\nM:2/4\nL:1/8\nK:G\nGA Bc|d2 B2|\n"
 */
export function tuneToAbc(tune, settingIndex = 0) {
  const problem = typeProblem(tune.type);
  if (problem) throw new Error(`This tune cannot be arranged: ${problem}.`);
  const setting = tune.settings?.[settingIndex];
  if (!setting) throw new RangeError(`the tune has no setting ${settingIndex}`);
  const body = setting.abc.replace(/\r\n?/g, "\n").trim();
  return [
    "X:1",
    `T:${tune.name}`,
    `R:${tune.type}`,
    `M:${meterOfType(tune.type)}`,
    `L:${UNIT}`,
    `K:${abcKey(setting.key ?? "")}`,
    body,
    "",
  ].join("\n");
}

/**
 * Normalize a search answer into search results, one per tune.
 *
 * A tune whose type cannot be arranged stays in the list with an `error` (a short reason, such
 * as "its type (march) does not fix a meter"), so the visitor sees why it does not open.
 *
 * @param {{tunes?: Array<{id: number, name: string, url?: string, type: string}>}} answer the
 *   search JSON
 * @returns {SearchResult[]}
 * @example
 * searchResults({ tunes: [{ id: 7, name: "Pretend Jig", url: "https://thesession.org/tunes/7", type: "jig" }] })[0].open;
 * // "https://thesession.org/tunes/7?format=json"
 */
export function searchResults(answer) {
  return (answer.tunes ?? []).map((tune) => {
    /** @type {SearchResult} */
    const result = {
      source: "thesession",
      id: String(tune.id),
      title: tune.name,
      composer: "",
      license: "",
      format: "abc",
      page: tune.url ?? "",
      open: tuneUrl(tune.id),
    };
    const problem = typeProblem(tune.type);
    if (problem) result.error = problem;
    return result;
  });
}

/**
 * Write a length in units of L: as ABC does: "5", "7/2", "1/4".
 *
 * @param {number} units a positive multiple of 1/64
 * @returns {string}
 */
function abcLength(units) {
  for (let denominator = 1; denominator <= MAX_DENOMINATOR; denominator *= 2) {
    const numerator = units * denominator;
    if (Math.abs(numerator - Math.round(numerator)) < 1e-9) {
      return denominator === 1 ? String(Math.round(numerator)) : `${Math.round(numerator)}/${denominator}`;
    }
  }
  throw new RangeError(`cannot write a rest of ${units} units`);
}

/**
 * Put a rest in front of a pickup, so the first bar of the tune is full (research R10).
 *
 * The rest goes before everything in the body, followed by a start-repeat sign that replaces
 * the tune's own, if it had one. A repeat then returns to the pickup, not to the rest, so every
 * downbeat after a repeat still falls on a bar line.
 *
 * @param {string} abc one tune, header and body
 * @param {number} pickupLength length of the pickup, in whole notes (abcjs `getPickupLength`)
 * @param {number} barLength length of a full bar, in whole notes (abcjs `getBarLength`)
 * @returns {string} the tune with the rest, or unchanged when it has no pickup
 * @example
 * padPickup("X:1\nM:6/8\nL:1/8\nK:D\nA|d2f a2f|\n", 1 / 8, 3 / 4);
 * // "X:1\nM:6/8\nL:1/8\nK:D\nz5|:A|d2f a2f|\n"
 */
export function padPickup(abc, pickupLength, barLength) {
  if (!(pickupLength > 0) || pickupLength >= barLength) return abc;
  const unitField = /^L:\s*(\d+)\/(\d+)/m.exec(abc);
  const unit = unitField ? Number(unitField[1]) / Number(unitField[2]) : 1 / 8;
  const rest = `z${abcLength((barLength - pickupLength) / unit)}|:`;

  const lines = abc.split("\n");
  const keyLine = lines.findIndex((line) => /^K:/.test(line));
  // The body starts at the first line after K: that is neither a field nor a comment.
  const first = lines.findIndex((line, i) => i > keyLine && line.trim() !== "" && !/^([A-Za-z]:|%)/.test(line));
  if (first < 0) return abc;
  lines[first] = rest + lines[first].replace(/^(?:\s|\[\||\|\]|\|\||\|:|::|\|)+/, "");
  return lines.join("\n");
}

/**
 * How long the first bar of a parsed tune lasts, in whole notes.
 *
 * abcjs's own `getPickupLength` misses a pickup that follows a start-repeat sign (`|:A|...`),
 * which is how most folk tunes begin, so the first bar is measured here: the notes and rests
 * of the first voice up to the first bar line after them, tuplets scaled.
 *
 * @param {any} tune an abcjs tune
 * @returns {number}
 */
function firstBarLength(tune) {
  const elements = tune.lines.flatMap((/** @type {any} */ line) => line.staff?.[0]?.voices?.[0] ?? []);
  let length = 0;
  let tupletScale = 1;
  for (const element of elements) {
    if (element.el_type === "bar") {
      if (length > 0) break;
      continue;
    }
    if (element.el_type !== "note" || element.rest?.type === "spacer") continue;
    if (element.rest?.type === "multimeasure") return tune.getBarLength();
    if (element.startTriplet) tupletScale = element.tripletMultiplier;
    length += element.duration * tupletScale;
    if (element.endTriplet) tupletScale = 1;
  }
  return length;
}

/**
 * The MIDI file of an ABC tune, with its repeats played out and its pickup padded (R10).
 *
 * abcjs writes the melody as track 0 and the chord symbols, if any, as a second track.
 *
 * @param {any} abcjs the ABCJS object (window.ABCJS in the page, `loadAbcjs()` in tests)
 * @param {string} abc one tune
 * @returns {Uint8Array} the MIDI file's bytes
 * @example
 * abcToMidi(ABCJS, tuneToAbc(tune, 0)); // Uint8Array starting with "MThd"
 */
export function abcToMidi(abcjs, abc) {
  const [tune] = abcjs.parseOnly(abc);
  const padded = padPickup(abc, firstBarLength(tune), tune.getBarLength());
  const [bytes] = abcjs.synth.getMidiFile(padded, { midiOutputType: "binary" });
  return bytes;
}
