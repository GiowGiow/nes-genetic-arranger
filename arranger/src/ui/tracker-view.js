// @ts-check
/**
 * Tracker view: the best arrangement so far as a tracker pattern.
 *
 * NES music was written in trackers (FamiTracker, NerdTracker): a table with one row per slice of
 * time and one column per sound channel, each cell holding the note that starts there. This view
 * shows the arrangement the genetic algorithm has found so far in that form: four columns, P1
 * (melody), P2 (harmony), TR (bass) and NO (drums as K kick, S snare, H hi-hat), one row per
 * sixteenth note (four to a beat), with the chord symbol in a column on its row. It is derived
 * from the real best plan (`assemble`), so as the plan improves the cells change, and the cells
 * that just changed flash.
 *
 * One bar is shown at a time (16 rows in 4/4), with buttons to move through the song: a full song
 * would be hundreds of rows. A sixteenth-note grid cannot show a 32nd-note arpeggio's every note;
 * where several notes start in one row the first is shown with a plus.
 */

import { assemble } from "../core/arrangement.js";
import { barStarts } from "../core/meter.js";
import { HIHAT, KICK, SNARE } from "../core/textures.js";

/** Rows in a beat (a quarter note): one row per sixteenth note. */
export const ROWS_PER_BEAT = 4;

const CHANNELS = /** @type {const} */ (["P1", "P2", "TR", "NO"]);
const NOTE_NAMES = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];
const DRUM_LETTERS = new Map([[KICK, "K"], [SNARE, "S"], [HIHAT, "H"]]);

/**
 * A pitch as a tracker writes it.
 *
 * @param {number} pitch MIDI pitch
 * @returns {string} for example "C-4" (middle C, MIDI 60) or "F#3"
 * @example
 * noteName(61); // "C#4"
 */
export function noteName(pitch) {
  return `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}

/**
 * One row of the pattern.
 * @typedef {object} TrackerRow
 * @property {number} bar the bar's number from 1
 * @property {number} row the row's index in its bar, from 0
 * @property {boolean} isBeat the row falls on a beat (the pattern's stripes)
 * @property {boolean} isBarStart the first row of a bar
 * @property {string} chord the chord symbol that begins on this row, else ""
 * @property {Record<"P1" | "P2" | "TR" | "NO", string>} cells the note that starts on this row
 *   in each channel: "C-5", "K", or "..." (".") when nothing starts
 */

/**
 * Keep a window of bars inside the song.
 *
 * @param {number} totalBars
 * @param {{firstBar: number, barCount: number}} window first bar counted from 0
 * @returns {{firstBar: number, barCount: number}}
 * @example
 * clampWindow(10, { firstBar: 9, barCount: 2 }); // { firstBar: 8, barCount: 2 }
 */
export function clampWindow(totalBars, { firstBar, barCount }) {
  const count = Math.max(1, Math.min(barCount, totalBars));
  return { firstBar: Math.max(0, Math.min(firstBar, totalBars - count)), barCount: count };
}

/**
 * The pattern rows of some bars of an arrangement.
 *
 * @param {{meters: Array<import("../core/meter.js").Meter>, channels: Record<string, Array<{pitch: number, onset: number}>>}} arrangement
 *   the channels' notes in beats from the start of the piece (`assemble`)
 * @param {{bars: Array<{chords: Array<{symbol: string, onset: number}>, meter: import("../core/meter.js").Meter}>}} leadSheet
 * @param {{firstBar: number, barCount: number}} window first bar counted from 0
 * @returns {TrackerRow[]}
 * @example
 * trackerRows(arrangement, leadSheet, { firstBar: 0, barCount: 1 })[0].cells.P1; // "C-5"
 */
export function trackerRows(arrangement, leadSheet, { firstBar, barCount }) {
  const starts = barStarts(leadSheet.bars);
  const { firstBar: first, barCount: count } = clampWindow(leadSheet.bars.length, { firstBar, barCount });
  /** @type {TrackerRow[]} */
  const rows = [];
  for (let index = first; index < first + count; index += 1) {
    const bar = leadSheet.bars[index];
    const start = starts[index];
    const barRows = Math.round(bar.meter.barBeats * ROWS_PER_BEAT);
    /** @type {Record<string, Map<number, {first: any, count: number}>>} */
    const hits = {};
    for (const channel of CHANNELS) {
      const found = new Map();
      for (const note of arrangement.channels[channel] ?? []) {
        if (note.onset < start - 1e-9 || note.onset >= start + bar.meter.barBeats - 1e-9) continue;
        const row = Math.floor((note.onset - start) * ROWS_PER_BEAT + 1e-6);
        const seen = found.get(row);
        if (seen) seen.count += 1;
        else found.set(row, { first: note, count: 1 });
      }
      hits[channel] = found;
    }
    for (let row = 0; row < barRows; row += 1) {
      const chord = bar.chords.find((segment) => Math.floor(segment.onset * ROWS_PER_BEAT + 1e-6) === row);
      rows.push({
        bar: index + 1,
        row,
        isBeat: row % ROWS_PER_BEAT === 0,
        isBarStart: row === 0,
        chord: chord?.symbol ?? "",
        cells: {
          P1: cell(hits.P1.get(row), false),
          P2: cell(hits.P2.get(row), false),
          TR: cell(hits.TR.get(row), false),
          NO: cell(hits.NO.get(row), true),
        },
      });
    }
  }
  return rows;
}

/**
 * @param {{first: {pitch: number}, count: number} | undefined} hit
 * @param {boolean} drum
 */
function cell(hit, drum) {
  if (!hit) return drum ? "." : "...";
  if (drum) return DRUM_LETTERS.get(hit.first.pitch) ?? "x";
  return `${noteName(hit.first.pitch)}${hit.count > 1 ? "+" : ""}`;
}

/**
 * The pattern as table markup.
 *
 * @param {TrackerRow[]} rows
 * @param {TrackerRow[]} [before] the rows last shown; cells that differ get the class `is-new`
 * @returns {string}
 */
export function trackerMarkup(rows, before) {
  const head =
    `<thead><tr><th scope="col" class="trk-num">Row</th><th scope="col" class="trk-chord">Chord</th>` +
    CHANNELS.map((channel) => `<th scope="col" class="trk-${channel.toLowerCase()}">${channel}</th>`).join("") +
    `</tr></thead>`;
  const body = rows
    .map((row, index) => {
      const old = before?.[index];
      const comparable = old && old.bar === row.bar && old.row === row.row;
      const cells = CHANNELS.map((channel) => {
        const changed = comparable && old.cells[channel] !== row.cells[channel];
        const empty = row.cells[channel] === "..." || row.cells[channel] === ".";
        return `<td class="trk-cell trk-${channel.toLowerCase()}${empty ? " is-empty" : ""}${changed ? " is-new" : ""}">${row.cells[channel]}</td>`;
      }).join("");
      const classes = ["trk-row", row.isBeat ? "is-beat" : "", row.isBarStart ? "is-bar" : ""].filter(Boolean).join(" ");
      const label = row.row.toString(16).toUpperCase().padStart(2, "0");
      return `<tr class="${classes}"><td class="trk-num">${label}</td><td class="trk-chord">${escapeText(row.chord)}</td>${cells}</tr>`;
    })
    .join("");
  return `<table class="tracker mono">${head}<tbody>${body}</tbody></table>`;
}

/** @param {string} text */
function escapeText(text) {
  return text.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);
}

/**
 * Build the view inside `container`: the pattern and the buttons that move through the bars.
 *
 * @param {HTMLElement} container
 * @returns {{
 *   setSong: (leadSheet: import("../core/leadsheet.js").LeadSheet) => void,
 *   update: (plan: Uint8Array) => void,
 * }} `setSong` names the lead sheet; `update` shows the arrangement of a plan (the best so far)
 * @example
 * const tracker = createTrackerView(host);
 * tracker.setSong(leadSheet);
 * tracker.update(message.bestPlan); // on every paced redraw
 */
export function createTrackerView(container) {
  container.classList.add("tracker-view");
  container.innerHTML =
    `<div class="tracker-bar">` +
    `<button type="button" class="button small" data-tracker-prev aria-label="Previous bar">Previous bar</button>` +
    `<span class="tracker-where mono" data-tracker-where aria-live="off">Bar 1</span>` +
    `<button type="button" class="button small" data-tracker-next aria-label="Next bar">Next bar</button></div>` +
    `<div class="tracker-scroll" data-tracker-table role="group" aria-label="Pattern of the best plan so far"></div>`;
  const table = /** @type {HTMLElement} */ (container.querySelector("[data-tracker-table]"));
  const where = /** @type {HTMLElement} */ (container.querySelector("[data-tracker-where]"));
  const previous = /** @type {HTMLButtonElement} */ (container.querySelector("[data-tracker-prev]"));
  const next = /** @type {HTMLButtonElement} */ (container.querySelector("[data-tracker-next]"));
  /** @type {import("../core/leadsheet.js").LeadSheet | null} */
  let song = null;
  /** @type {Uint8Array | null} */
  let plan = null;
  let firstBar = 0;
  /** @type {TrackerRow[] | undefined} */
  let shown;

  function draw() {
    if (!song || !plan) return;
    const arrangement = assemble(song, plan);
    const window = clampWindow(song.bars.length, { firstBar, barCount: 1 });
    firstBar = window.firstBar;
    const rows = trackerRows(arrangement, song, window);
    table.innerHTML = trackerMarkup(rows, shown);
    shown = rows;
    where.textContent = `Bar ${firstBar + 1} of ${song.bars.length}`;
    previous.disabled = firstBar === 0;
    next.disabled = firstBar >= song.bars.length - 1;
  }

  /** @param {number} step */
  function move(step) {
    if (!song) return;
    firstBar = Math.max(0, Math.min(song.bars.length - 1, firstBar + step));
    shown = undefined; // another bar: nothing in it is new
    draw();
  }
  previous.addEventListener("click", () => move(-1));
  next.addEventListener("click", () => move(1));

  return {
    setSong(leadSheet) {
      song = leadSheet;
      plan = null;
      firstBar = 0;
      shown = undefined;
      table.replaceChildren();
      where.textContent = `Bar 1 of ${leadSheet.bars.length}`;
      previous.disabled = true;
      next.disabled = leadSheet.bars.length < 2;
    },
    update(newPlan) {
      plan = newPlan;
      draw();
    },
  };
}
