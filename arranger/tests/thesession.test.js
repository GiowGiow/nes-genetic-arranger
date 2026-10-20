// @ts-check
// Tests for core/thesession.js: the browser's own client for a folk tune site's API (spec 005,
// FR-018, research R9 and R10).
//
// LICENSE RULE (constitution 2.0.0): the site's data may not be processed by language models.
// Every tune, name and ABC body below is invented for these tests, shaped like the documented
// API (search: `tunes: [{id, name, url, type}]`; tune: `settings: [{id, key, abc}]`). The tests
// never touch the network.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { readMidiFile } from "../src/core/midi-file.js";
import {
  METER_BY_TYPE,
  abcKey,
  abcToMidi,
  meterOfType,
  padPickup,
  searchResults,
  searchUrl,
  tuneToAbc,
  tuneUrl,
} from "../src/core/thesession.js";
import { loadAbcjs, repoRoot } from "./helpers.js";

/** An invented reel with two settings. */
const INVENTED_REEL = {
  id: 90501,
  name: "The Invented Reel",
  url: "https://thesession.org/tunes/90501",
  type: "reel",
  settings: [
    { id: 1, key: "Adorian", abc: '|:"Am"eA A2 eAAB|"G"G2 BG dGBG:|\r\n|:"Am"a2 ea g2 eg|"G"dB GB A4:|' },
    { id: 2, key: "Gmajor", abc: "GABc d2 BG|A2 FA D4|" },
  ],
};

test("the search and tune URLs ask the API for JSON", () => {
  assert.equal(searchUrl("polka & co"), "https://thesession.org/tunes/search?q=polka%20%26%20co&format=json&perpage=50");
  assert.equal(tuneUrl(90501), "https://thesession.org/tunes/90501?format=json");
});

test("the tune type gives the meter, as the site files each type", () => {
  assert.deepEqual(
    { ...METER_BY_TYPE },
    {
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
    },
  );
  assert.equal(meterOfType("Slip Jig"), "9/8", "letter case does not matter");
  assert.equal(meterOfType("three-two"), "3/2", "a three-two tune opens in 3/2 (spec 006)");
  assert.equal(meterOfType("march"), null, "a type that does not fix its meter is unsupported");
});

test("API key names become ABC keys", () => {
  assert.equal(abcKey("Dmajor"), "D");
  assert.equal(abcKey("Eminor"), "Em");
  assert.equal(abcKey("Adorian"), "Ador");
  assert.equal(abcKey("Gmixolydian"), "Gmix");
  assert.equal(abcKey("Bbmajor"), "Bb");
  assert.equal(abcKey("F#minor"), "F#m");
  assert.equal(abcKey("Clydian"), "Clyd");
  assert.equal(abcKey("Ephrygian"), "Ephr");
  assert.equal(abcKey("Blocrian"), "Bloc");
  assert.equal(abcKey(""), "C", "a setting without a key reads as C major");
});

test("a tune setting becomes a complete ABC tune: number, title, type, meter, unit, key, then the body", () => {
  assert.equal(
    tuneToAbc(INVENTED_REEL, 0),
    [
      "X:1",
      "T:The Invented Reel",
      "R:reel",
      "M:4/4",
      "L:1/8",
      "K:Ador",
      '|:"Am"eA A2 eAAB|"G"G2 BG dGBG:|',
      '|:"Am"a2 ea g2 eg|"G"dB GB A4:|',
      "",
    ].join("\n"),
  );
  assert.match(tuneToAbc(INVENTED_REEL, 1), /\nK:G\nGABc d2 BG\|A2 FA D4\|\n$/);
  // The doc comment's example.
  assert.equal(
    tuneToAbc({ id: 1, name: "Pretend Polka", type: "polka", settings: [{ key: "Gmajor", abc: "GA Bc|d2 B2|" }] }),
    "X:1\nT:Pretend Polka\nR:polka\nM:2/4\nL:1/8\nK:G\nGA Bc|d2 B2|\n",
  );
});

test("a three-two tune is assembled in 3/2", () => {
  const threeTwo = { ...INVENTED_REEL, type: "three-two" };

  assert.match(tuneToAbc(threeTwo, 0), /\nR:three-two\nM:3\/2\nL:1\/8\nK:Ador\n/);
});

test("a tune of a type that fixes no meter, or a missing setting, cannot be arranged", () => {
  assert.throws(
    () => tuneToAbc({ ...INVENTED_REEL, type: "march" }, 0),
    /cannot be arranged: its type \(march\) does not fix a meter/,
  );
  assert.throws(() => tuneToAbc(INVENTED_REEL, 5), { name: "RangeError", message: /setting 5/ });
});

test("search results are normalized; a tune of a type that fixes no meter is listed but marked", () => {
  const search = {
    q: "invented",
    total: 3,
    tunes: [
      { id: 90501, name: "The Invented Reel", url: "https://thesession.org/tunes/90501", type: "reel" },
      { id: 90502, name: "Made-up March", url: "https://thesession.org/tunes/90502", type: "march" },
      { id: 90503, name: "Pretend Three-Two", url: "https://thesession.org/tunes/90503", type: "three-two" },
    ],
  };
  const results = searchResults(search);
  assert.deepEqual(results[0], {
    source: "thesession",
    id: "90501",
    title: "The Invented Reel",
    composer: "",
    license: "",
    format: "abc",
    page: "https://thesession.org/tunes/90501",
    open: "https://thesession.org/tunes/90501?format=json",
  });
  // A short reason, as catalog entries state theirs; the page wraps it in a sentence.
  assert.equal(results[1].error, "its type (march) does not fix a meter");
  assert.equal(results[2].error, undefined, "a three-two tune can be arranged now");
  assert.deepEqual(searchResults({}), [], "an answer without tunes gives no results");
});

// --- Pickup bars (research R10) ---------------------------------------------------------------

test("a pickup gets a leading rest that fills its bar, and a repeat sign keeps the rest out of repeats", () => {
  // 6/8 with L:1/8: a pickup of one eighth (1/8 of a whole note) needs a rest of five eighths.
  assert.equal(
    padPickup("X:1\nM:6/8\nL:1/8\nK:D\nA|d2f a2f|d3 d2:|\n", 1 / 8, 3 / 4),
    "X:1\nM:6/8\nL:1/8\nK:D\nz5|:A|d2f a2f|d3 d2:|\n",
  );
  assert.equal(
    padPickup("X:1\nM:6/8\nL:1/8\nK:D\n|:A|d2f a2f|d3 d2:|\n", 1 / 8, 3 / 4),
    "X:1\nM:6/8\nL:1/8\nK:D\nz5|:A|d2f a2f|d3 d2:|\n",
    "the tune's own start repeat moves after the rest",
  );
});

test("the doc comment's pickup example", () => {
  assert.equal(padPickup("X:1\nM:6/8\nL:1/8\nK:D\nA|d2f a2f|\n", 1 / 8, 3 / 4), "X:1\nM:6/8\nL:1/8\nK:D\nz5|:A|d2f a2f|\n");
});

test("the rest length is written in the tune's unit, as a fraction when needed", () => {
  assert.match(padPickup("X:1\nM:2/4\nL:1/8\nK:G\nG/|A2 B2|\n", 1 / 16, 1 / 2), /\nz7\/2\|:G\/\|/);
  assert.match(padPickup("X:1\nM:6/8\nL:1/16\nK:D\nA2|d4f2 a4f2|\n", 1 / 8, 3 / 4), /\nz10\|:A2\|/);
});

test("a tune without a pickup is left as it is", () => {
  const tune = "X:1\nM:4/4\nL:1/8\nK:G\nGABc dBGB|\n";
  assert.equal(padPickup(tune, 0, 1), tune);
  assert.equal(padPickup(tune, 1, 1), tune, "a first bar that is already full");
});

test("the ABC-to-MIDI route puts every downbeat on a bar line, also after a repeat", () => {
  const abcjs = loadAbcjs();
  const abc = 'X:1\nT:Invented Pickup Jig\nM:6/8\nL:1/8\nK:D\n|:A|"D"d2f a2f|"D"d3 d2:|\n';
  const midi = readMidiFile(abcToMidi(abcjs, abc));
  const quartersPerSecond = midi.tempoChanges[0].bpm / 60;
  const onsets = midi.instruments[0].notes.map((note) => Math.round(note.start * quartersPerSecond * 1000) / 1000);
  // Bars of 6/8 are 3 quarters long: the pickup A sits at 2.5, the downbeats at 3, 6, 9 and 12.
  assert.deepEqual(onsets, [2.5, 3, 4, 4.5, 5.5, 6, 7.5, 8.5, 9, 10, 10.5, 11.5, 12, 13.5]);
});

test("the client never calls the network itself: the caller fetches", () => {
  const source = readFileSync(join(repoRoot, "arranger/src/core/thesession.js"), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /XMLHttpRequest/);
});
