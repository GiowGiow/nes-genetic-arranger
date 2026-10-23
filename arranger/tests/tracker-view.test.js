// @ts-check
// Tests for ui/tracker-view.js: the best arrangement as a tracker pattern, one row per sixteenth
// note and one column per channel, in the style of the NES trackers. The rows are pure data.

import assert from "node:assert/strict";
import { test } from "node:test";

import { FOUR_FOUR, parseMeter } from "../src/core/meter.js";
import { HIHAT, KICK, SNARE } from "../src/core/textures.js";
import { ROWS_PER_BEAT, clampWindow, noteName, trackerMarkup, trackerRows } from "../src/ui/tracker-view.js";

/** @param {string} symbol @param {number} onset @param {number} duration */
const chord = (symbol, onset, duration) => ({ symbol, root: 0, tones: [0, 4, 7], onset, duration });

/** @param {number} index @param {any[]} chords @param {any} [meter] */
const bar = (index, chords, meter = FOUR_FOUR) => ({
  index, melody: [], chords, label: "A", role: /** @type {const} */ ("verse"), phrase: 0, phraseEnd: false, meter,
});

const leadSheet = {
  title: "Test", key: "C major", tempoBpm: 120, sourceGrid: null,
  bars: [bar(0, [chord("C", 0, 4)]), bar(1, [chord("F", 0, 2), chord("Am", 2, 2)])],
};
/** @param {number} pitch @param {number} onset @param {number} [duration] */
const note = (pitch, onset, duration = 1) => ({ pitch, onset, duration, velocity: 80 });
const arrangement = {
  meters: leadSheet.bars.map((entry) => entry.meter),
  channels: {
    P1: [note(72, 0), note(74, 1.5, 0.5), note(76, 4)],
    P2: [note(48, 0, 4), note(53, 4, 2), note(57, 6, 2)],
    TR: [note(36, 0, 2), note(43, 2, 2)],
    NO: [note(KICK, 0, 0.25), note(SNARE, 1, 0.25), note(HIHAT, 1.25, 0.25)],
  },
};

test("note names follow the trackers: a letter, a dash or a sharp, and the octave, with middle C as C-4", () => {
  assert.equal(noteName(60), "C-4");
  assert.equal(noteName(61), "C#4");
  assert.equal(noteName(81), "A-5");
  assert.equal(noteName(40), "E-2");
  assert.equal(noteName(21), "A-0");
});

test("a bar of four beats has sixteen rows, four to a beat", () => {
  assert.equal(ROWS_PER_BEAT, 4);
  const rows = trackerRows(arrangement, leadSheet, { firstBar: 0, barCount: 1 });

  assert.equal(rows.length, 16);
  assert.deepEqual(rows.map((row) => row.row).slice(0, 3), [0, 1, 2]);
});

test("a note shows on the row where it starts, and the other rows of the channel are empty", () => {
  const rows = trackerRows(arrangement, leadSheet, { firstBar: 0, barCount: 1 });

  assert.equal(rows[0].cells.P1, "C-5");
  assert.equal(rows[0].cells.P2, "C-3");
  assert.equal(rows[0].cells.TR, "C-2");
  assert.equal(rows[1].cells.P1, "...");
  assert.equal(rows[6].cells.P1, "D-5", "beat 1.5 is row 6");
  assert.equal(rows[8].cells.TR, "G-2", "beat 2 is row 8");
});

test("drums show as K, S and H", () => {
  const rows = trackerRows(arrangement, leadSheet, { firstBar: 0, barCount: 1 });

  assert.deepEqual([rows[0].cells.NO, rows[4].cells.NO, rows[5].cells.NO, rows[6].cells.NO], ["K", "S", "H", "."]);
});

test("beats and the first row of each bar are marked, for the stripes of the pattern", () => {
  const rows = trackerRows(arrangement, leadSheet, { firstBar: 0, barCount: 2 });

  assert.deepEqual(rows.filter((row) => row.isBeat).length, 8);
  assert.deepEqual(rows.filter((row) => row.isBarStart).map((row) => row.bar), [1, 2]);
});

test("a window of the second bar starts at its notes, and numbers the bar from 1", () => {
  const rows = trackerRows(arrangement, leadSheet, { firstBar: 1, barCount: 1 });

  assert.equal(rows.length, 16);
  assert.equal(rows[0].bar, 2);
  assert.equal(rows[0].cells.P1, "E-5");
  assert.equal(rows[0].cells.P2, "F-3");
});

test("the chord symbol sits on the row where the chord begins", () => {
  const rows = trackerRows(arrangement, leadSheet, { firstBar: 0, barCount: 2 });

  assert.equal(rows[0].chord, "C");
  assert.equal(rows[16].chord, "F");
  assert.equal(rows[24].chord, "Am");
  assert.equal(rows[1].chord, "");
});

test("a bar of another meter has its own number of rows: 3/4 has twelve, 6/8 twelve, 7/8 fourteen", () => {
  for (const [text, rowsExpected] of [["3/4", 12], ["6/8", 12], ["7/8", 14]]) {
    const meter = parseMeter(text, 1);
    const sheet = { ...leadSheet, bars: [bar(0, [chord("C", 0, meter.barBeats)], meter)] };
    const rows = trackerRows({ meters: [meter], channels: { P1: [], P2: [], TR: [], NO: [] } }, sheet, { firstBar: 0, barCount: 1 });
    assert.equal(rows.length, rowsExpected, text);
  }
});

test("when several notes start in one row (a 32nd arpeggio) the first shows with a plus", () => {
  const dense = { ...arrangement, channels: { ...arrangement.channels, P2: [note(48, 0, 0.125), note(52, 0.125, 0.125)] } };
  const rows = trackerRows(dense, leadSheet, { firstBar: 0, barCount: 1 });

  assert.equal(rows[0].cells.P2, "C-3+");
});

test("a window is kept inside the song: it never starts before bar 1 or runs past the last bar", () => {
  assert.deepEqual(clampWindow(10, { firstBar: 8, barCount: 2 }), { firstBar: 8, barCount: 2 });
  assert.deepEqual(clampWindow(10, { firstBar: 9, barCount: 2 }), { firstBar: 8, barCount: 2 });
  assert.deepEqual(clampWindow(10, { firstBar: -3, barCount: 2 }), { firstBar: 0, barCount: 2 });
  assert.deepEqual(clampWindow(1, { firstBar: 0, barCount: 2 }), { firstBar: 0, barCount: 1 });
});

test("the markup is a table of rows with a header of the four channels", () => {
  const markup = trackerMarkup(trackerRows(arrangement, leadSheet, { firstBar: 0, barCount: 1 }));

  for (const channel of ["P1", "P2", "TR", "NO"]) assert.match(markup, new RegExp(`>${channel}<`));
  assert.equal(markup.match(/<tr class="trk-row/g)?.length, 16);
  assert.match(markup, /is-beat/);
  assert.match(markup, /C-5/);
});

test("given the rows shown before, the cells that changed are marked, so the view can flash them", () => {
  const before = trackerRows(arrangement, leadSheet, { firstBar: 0, barCount: 1 });
  const changed = { ...arrangement, channels: { ...arrangement.channels, P2: [note(50, 0, 4)] } };
  const after = trackerRows(changed, leadSheet, { firstBar: 0, barCount: 1 });
  const markup = trackerMarkup(after, before);

  assert.equal(markup.match(/is-new/g)?.length, 1, "only the P2 cell of row 0 differs");
  assert.doesNotMatch(trackerMarkup(before, before), /is-new/);
  assert.doesNotMatch(trackerMarkup(after), /is-new/, "the first time nothing is new");
});
