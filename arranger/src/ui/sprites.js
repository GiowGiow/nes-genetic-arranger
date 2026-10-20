// @ts-check
/**
 * Song sprites: a 16×16 pixel-art figure for every catalog song, like the save icons of an old
 * console's memory card (spec 005, FR-010, research R5).
 *
 * The catalog holds thousands of songs, and a title alone is hard to scan. A small picture per
 * song gives the eye something to hold on to, and it must be the same picture on every visit and
 * every device. So the picture is drawn from numbers the catalog already stores:
 *
 * - **Figure.** The song's sprite seed (the first 32 bits of SHA-256 of `source:id`, written
 *   with the catalog) starts the app's seeded generator (`core/random.js`). The generator fills
 *   the left half of the grid, cell by cell, as empty, body, shade or accent. Cells near the
 *   centre fill more often, so the figure is a blob rather than noise. The right half mirrors
 *   the left: symmetric random shapes read as creatures or emblems. Every empty cell next to the
 *   figure then becomes a dark outline, so the figure stands out on any background.
 * - **Colors.** They come from the NES's own palette (the 2C02 picture chip's 64 colors). The
 *   palette has 12 hue columns, and a key has 12 possible tonics, so the tonic picks the hue:
 *   tonics a fifth apart (C, G, D, …) get neighbouring columns, so related keys look related.
 *   A major key draws the body from the light row and a minor key from the dark row. The accent
 *   and the record's label take two of the four channel colors (P1, P2, TR, NO).
 *
 * The key changes only the colors, never the figure, because the generator draws the same
 * numbers in the same order whatever the key.
 */

import { createRandom } from "../core/random.js";

/** Width and height of a sprite, in cells. */
export const SPRITE_SIZE = 16;

/** What each cell of a sprite grid holds; the number is also the index into `colors`. */
export const CELL = Object.freeze({ EMPTY: 0, BODY: 1, SHADE: 2, ACCENT: 3, OUTLINE: 4 });

/** The four channel colors of the page, in channel order P1, P2, TR, NO (style.css). */
export const CHANNEL_COLORS = Object.freeze(["#5F9ED1", "#FF800E", "#CFCFCF", "#FFBC79"]);

/**
 * The 64 colors of the NES picture chip (2C02), in hardware order: four rows of sixteen, so
 * color $21 is row 2, column 1. Columns 1 to 12 are hues; column 0 is grey and 13 to 15 are
 * (nearly) black. This is the palette most emulators show.
 */
export const NES_PALETTE = Object.freeze([
  "#7C7C7C", "#0000FC", "#0000BC", "#4428BC", "#940084", "#A80020", "#A81000", "#881400",
  "#503000", "#007800", "#006800", "#005800", "#004058", "#000000", "#000000", "#000000",
  "#BCBCBC", "#0078F8", "#0058F8", "#6844FC", "#D800CC", "#E40058", "#F83800", "#E45C10",
  "#AC7C00", "#00B800", "#00A800", "#00A844", "#008888", "#000000", "#000000", "#000000",
  "#F8F8F8", "#3CBCFC", "#6888FC", "#9878F8", "#F878F8", "#F85898", "#F87858", "#FCA044",
  "#F8B800", "#B8F818", "#58D854", "#58F898", "#00E8D8", "#787878", "#000000", "#000000",
  "#FCFCFC", "#A4E4FC", "#B8B8F8", "#D8B8F8", "#F8B8F8", "#F8A4C0", "#F0D0B0", "#FCE0A8",
  "#F8D878", "#D8F878", "#B8F8B8", "#B8F8D8", "#00FCFC", "#F8D8F8", "#000000", "#000000",
]);

const OUTLINE_COLOR = "#0B0B18";

/** First and last row and column the figure may fill, leaving room for the outline. */
const FIGURE_FIRST = 2;
const FIGURE_LAST = SPRITE_SIZE - 3;
const CENTRE = (SPRITE_SIZE - 1) / 2;

/** Semitones above C of each letter name. */
const LETTER_PITCH = Object.freeze({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 });

/** Mode names (first three letters) that sound major or minor; "m" alone means minor. */
const MAJOR_MODES = new Set(["maj", "ion", "mix", "lyd"]);
const MINOR_MODES = new Set(["min", "aeo", "dor", "phr", "loc", "m"]);

/**
 * @typedef {object} Sprite
 * @property {number[][]} grid 16 rows of 16 cells, each a `CELL` value
 * @property {Array<string | null>} colors the color of each `CELL` value; null for EMPTY
 * @property {string} label the record label's channel color
 */

/**
 * @typedef {object} KeyColoring
 * @property {number | null} tonic pitch class of the key's tonic (0 = C), or null when unknown
 * @property {boolean} minor whether the key sounds minor (minor, dorian, phrygian, …)
 */

/**
 * The NES hue column of a tonic: its place on the circle of fifths, from 1 (C) to 12 (F).
 *
 * @param {number} tonic a pitch class, 0 to 11
 * @returns {number} a column of the NES palette, 1 to 12
 * @example
 * hueColumn(0); // 1, C
 * hueColumn(7); // 2, G: a fifth above C sits next to it
 */
export function hueColumn(tonic) {
  return 1 + ((tonic * 7) % 12);
}

/**
 * Read a key name into the tonic and the mode that color a sprite.
 *
 * It accepts the spellings the catalog meets: music21's ("e- minor", lowercase tonic for
 * minor), ABC's ("Bb", "Am", "Ddor") and The Session API's ("Dmajor", "Eminor").
 *
 * @param {string} keyName
 * @returns {KeyColoring} `tonic` null when the name is not a key
 * @example
 * keyColoring("e- minor"); // { tonic: 3, minor: true }
 * keyColoring("Bb"); // { tonic: 10, minor: false }
 */
export function keyColoring(keyName) {
  const parts = /^([A-Ga-g])([#b-]*)\s*([A-Za-z]*)$/.exec(keyName.trim());
  if (parts === null) return { tonic: null, minor: false };
  const [, letter, accidentals, modeWord] = parts;
  const mode = modeWord.toLowerCase();
  const prefix = mode === "m" ? "m" : mode.slice(0, 3);
  let minor;
  if (mode === "") minor = letter === letter.toLowerCase(); // music21 writes minor keys in lowercase
  else if (MAJOR_MODES.has(prefix)) minor = false;
  else if (MINOR_MODES.has(prefix)) minor = true;
  else return { tonic: null, minor: false };
  const shift = [...accidentals].reduce((sum, sign) => sum + (sign === "#" ? 1 : -1), 0);
  const base = LETTER_PITCH[/** @type {keyof typeof LETTER_PITCH} */ (letter.toUpperCase())];
  return { tonic: (((base + shift) % 12) + 12) % 12, minor };
}

/**
 * The sprite of a seed, colored by a key.
 *
 * @param {number} seed the song's sprite seed, an integer from 0 to 2^32 - 1
 * @param {Partial<KeyColoring>} [key] tonic and mode; an unknown tonic lets the seed pick the hue
 * @returns {Sprite}
 * @example
 * const sprite = spriteFor(4242, { tonic: 9, minor: true }); // A minor
 * sprite.grid[5][3] === sprite.grid[5][12]; // true: mirrored left to right
 * sprite.colors[CELL.BODY]; // "#D800CC": NES_PALETTE[0x10 + hueColumn(9)], the dark row
 */
export function spriteFor(seed, key = {}) {
  const random = createRandom(seed >>> 0);
  // Drawn first and always, so the figure below never depends on the key.
  const seedHue = random.integer(1, 13);
  const label = random.integer(0, 4);
  const accent = (label + random.integer(1, 4)) % 4;

  const grid = Array.from({ length: SPRITE_SIZE }, () => new Array(SPRITE_SIZE).fill(CELL.EMPTY));
  for (let y = FIGURE_FIRST; y <= FIGURE_LAST; y++) {
    for (let x = FIGURE_FIRST; x < SPRITE_SIZE / 2; x++) {
      const draw = random.float();
      // Near the centre a cell fills about 6 times in 10, at the rim about 2 in 10.
      const distance = Math.hypot(x - CENTRE, y - CENTRE) / 7;
      if (draw <= 0.35 + 0.45 * distance) continue;
      const cell = draw > 0.86 ? CELL.ACCENT : draw > 0.62 ? CELL.SHADE : CELL.BODY;
      grid[y][x] = cell;
      grid[y][SPRITE_SIZE - 1 - x] = cell;
    }
  }
  outline(grid);

  const column = key.tonic == null ? seedHue : hueColumn(key.tonic);
  const bodyRow = key.minor ? 0x10 : 0x20;
  return {
    grid,
    colors: [null, NES_PALETTE[bodyRow + column], NES_PALETTE[bodyRow - 0x10 + column], CHANNEL_COLORS[accent], OUTLINE_COLOR],
    label: CHANNEL_COLORS[label],
  };
}

/**
 * Turn every empty cell that touches the figure (up, down, left or right) into outline.
 *
 * @param {number[][]} grid changed in place
 */
function outline(grid) {
  const touches = (/** @type {number} */ x, /** @type {number} */ y) =>
    [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const cell = grid[y + dy]?.[x + dx];
      return cell !== undefined && cell !== CELL.EMPTY && cell !== CELL.OUTLINE;
    });
  const edge = [];
  for (let y = 0; y < SPRITE_SIZE; y++) {
    for (let x = 0; x < SPRITE_SIZE; x++) if (grid[y][x] === CELL.EMPTY && touches(x, y)) edge.push([x, y]);
  }
  for (const [x, y] of edge) grid[y][x] = CELL.OUTLINE;
}

/**
 * The sprite of a catalog entry: its sprite seed, colored by the key of its analysis facts.
 *
 * @param {{seed?: number, facts?: {key?: string}}} entry
 * @returns {Sprite}
 * @example
 * entrySprite({ seed: 4242, facts: { key: "a minor" } }); // spriteFor(4242, { tonic: 9, minor: true })
 */
export function entrySprite(entry) {
  return spriteFor(entry.seed ?? 0, keyColoring(entry.facts?.key ?? ""));
}

/**
 * Paint a sprite on a 2D canvas, one square of `scale` pixels per colored cell.
 *
 * @param {CanvasRenderingContext2D} context
 * @param {Sprite} sprite
 * @param {number} x left edge, in canvas pixels
 * @param {number} y top edge, in canvas pixels
 * @param {number} scale pixels per cell
 * @returns {void}
 * @example
 * drawSprite(canvas.getContext("2d"), entrySprite(entry), 0, 0, 1); // a 16×16 canvas
 */
export function drawSprite(context, sprite, x, y, scale) {
  sprite.grid.forEach((row, j) =>
    row.forEach((cell, i) => {
      const color = sprite.colors[cell];
      if (!color) return;
      context.fillStyle = color;
      context.fillRect(x + i * scale, y + j * scale, scale, scale);
    }),
  );
}
