// @ts-check
// Tests for ui/sprites.js: every catalog song gets a 16×16 pixel-art sprite drawn from its seed,
// mirrored like a save icon, outlined, and colored from the NES palette by the song's key
// (spec 005, FR-010, research R5).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CELL,
  CHANNEL_COLORS,
  NES_PALETTE,
  SPRITE_SIZE,
  drawSprite,
  entrySprite,
  hueColumn,
  keyColoring,
  spriteFor,
} from "../src/ui/sprites.js";

const SEEDS = Array.from({ length: 200 }, (_, i) => (i * 2654435761) >>> 0);

/**
 * The cells of a grid with their 4 neighbours (up, down, left, right) that lie inside it.
 *
 * @param {number[][]} grid
 * @returns {Array<{x: number, y: number, cell: number, neighbours: number[]}>}
 */
function cellsOf(grid) {
  const steps = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  return grid.flatMap((row, y) =>
    row.map((cell, x) => ({
      x,
      y,
      cell,
      neighbours: steps.map(([dx, dy]) => grid[y + dy]?.[x + dx]).filter((value) => value !== undefined),
    })),
  );
}

const isFigure = (/** @type {number} */ cell) => cell === CELL.BODY || cell === CELL.SHADE || cell === CELL.ACCENT;

/**
 * Relative luminance of "#rrggbb", from 0 (black) to 255 (white).
 * @param {string} color
 */
function luminance(color) {
  const [r, g, b] = [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test("the same seed always gives the same sprite, and another seed gives another one", () => {
  assert.deepEqual(spriteFor(1234, { tonic: 0, minor: false }), spriteFor(1234, { tonic: 0, minor: false }));
  const grids = new Set(SEEDS.map((seed) => JSON.stringify(spriteFor(seed).grid)));
  assert.equal(grids.size, SEEDS.length, "200 seeds give 200 different figures");
});

test("the key changes the colors but not the figure, so a song keeps its shape", () => {
  const major = spriteFor(77, { tonic: 0, minor: false });
  const minor = spriteFor(77, { tonic: 9, minor: true });
  assert.deepEqual(major.grid, minor.grid);
  assert.notDeepEqual(major.colors, minor.colors);
});

test("a sprite is a 16×16 grid, mirrored left to right", () => {
  assert.equal(SPRITE_SIZE, 16);
  for (const seed of SEEDS) {
    const { grid } = spriteFor(seed);
    assert.equal(grid.length, 16);
    for (const row of grid) {
      assert.equal(row.length, 16);
      assert.deepEqual(row, [...row].reverse(), `seed ${seed}: row ${row} is not symmetric`);
    }
  }
});

test("a dark outline surrounds the figure: no figure cell touches an empty cell or the edge", () => {
  for (const seed of SEEDS) {
    for (const { x, y, cell, neighbours } of cellsOf(spriteFor(seed).grid)) {
      if (!isFigure(cell)) continue;
      assert.equal(neighbours.length, 4, `seed ${seed}: figure cell (${x}, ${y}) lies on the edge`);
      assert.ok(!neighbours.includes(CELL.EMPTY), `seed ${seed}: figure cell (${x}, ${y}) touches an empty cell`);
    }
  }
});

test("every outline cell touches the figure, so the outline is one pixel thick", () => {
  for (const seed of SEEDS) {
    for (const { x, y, cell, neighbours } of cellsOf(spriteFor(seed).grid)) {
      if (cell !== CELL.OUTLINE) continue;
      assert.ok(neighbours.some(isFigure), `seed ${seed}: outline cell (${x}, ${y}) is alone`);
    }
  }
  assert.equal(spriteFor(5).colors[CELL.OUTLINE], "#0B0B18");
});

test("every sprite has enough body to read as a figure, so no label is blank", () => {
  for (const seed of SEEDS) {
    const filled = spriteFor(seed).grid.flat().filter(isFigure).length;
    assert.ok(filled >= 16, `seed ${seed} has only ${filled} figure cells`);
  }
});

test("the NES palette has the 64 colors of the 2C02, four rows of sixteen", () => {
  assert.equal(NES_PALETTE.length, 64);
  assert.equal(NES_PALETTE[0x00], "#7C7C7C");
  assert.equal(NES_PALETTE[0x21], "#3CBCFC");
  assert.equal(NES_PALETTE[0x16], "#F83800");
});

test("the tonic picks the hue on the circle of fifths: C is column 1, G column 2, F column 12", () => {
  assert.equal(hueColumn(0), 1);
  assert.equal(hueColumn(7), 2);
  assert.equal(hueColumn(2), 3);
  assert.equal(hueColumn(5), 12);
  const columns = Array.from({ length: 12 }, (_, tonic) => hueColumn(tonic));
  assert.deepEqual([...columns].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test("a key gives the same body color to every song in it", () => {
  for (const seed of SEEDS.slice(0, 20)) {
    assert.equal(spriteFor(seed, { tonic: 0, minor: false }).colors[CELL.BODY], NES_PALETTE[0x21]);
    assert.equal(spriteFor(seed, { tonic: 0, minor: true }).colors[CELL.BODY], NES_PALETTE[0x11]);
    assert.equal(spriteFor(seed, { tonic: 7, minor: false }).colors[CELL.SHADE], NES_PALETTE[0x12]);
  }
});

test("a major key gives a light body and a minor key a dark one, in the same hue", () => {
  for (let tonic = 0; tonic < 12; tonic++) {
    const major = spriteFor(9, { tonic, minor: false }).colors;
    const minor = spriteFor(9, { tonic, minor: true }).colors;
    assert.ok(luminance(String(major[CELL.BODY])) > luminance(String(minor[CELL.BODY])), `tonic ${tonic}`);
    for (const colors of [major, minor]) {
      assert.ok(NES_PALETTE.includes(String(colors[CELL.BODY])));
      assert.ok(NES_PALETTE.includes(String(colors[CELL.SHADE])));
    }
  }
});

test("without a known key, the seed picks the hue, still from the NES palette", () => {
  const bodies = new Set(SEEDS.map((seed) => spriteFor(seed).colors[CELL.BODY]));
  assert.ok(bodies.size > 6, "unknown keys spread over many hues");
  for (const body of bodies) assert.ok(NES_PALETTE.includes(String(body)));
});

test("the accent and the record label are two different channel colors", () => {
  assert.deepEqual(CHANNEL_COLORS, ["#5F9ED1", "#FF800E", "#CFCFCF", "#FFBC79"]);
  const labels = new Set();
  for (const seed of SEEDS) {
    const sprite = spriteFor(seed);
    assert.ok(CHANNEL_COLORS.includes(sprite.label));
    assert.ok(CHANNEL_COLORS.includes(String(sprite.colors[CELL.ACCENT])));
    assert.notEqual(sprite.label, sprite.colors[CELL.ACCENT]);
    labels.add(sprite.label);
  }
  assert.equal(labels.size, 4, "labels use all four channel colors");
});

test("key names are read in the music21, ABC and API spellings", () => {
  assert.deepEqual(keyColoring("C major"), { tonic: 0, minor: false });
  assert.deepEqual(keyColoring("e- minor"), { tonic: 3, minor: true });
  assert.deepEqual(keyColoring("f# minor"), { tonic: 6, minor: true });
  assert.deepEqual(keyColoring("Am"), { tonic: 9, minor: true });
  assert.deepEqual(keyColoring("Bb"), { tonic: 10, minor: false });
  assert.deepEqual(keyColoring("D dorian"), { tonic: 2, minor: true });
  assert.deepEqual(keyColoring("Dmajor"), { tonic: 2, minor: false });
  assert.deepEqual(keyColoring("Eminor"), { tonic: 4, minor: true });
  assert.deepEqual(keyColoring("Gmixolydian"), { tonic: 7, minor: false });
  assert.deepEqual(keyColoring(""), { tonic: null, minor: false });
  assert.deepEqual(keyColoring("not a key"), { tonic: null, minor: false });
});

test("a catalog entry's sprite comes from its seed and the key of its facts", () => {
  const entry = { id: "x", t: "Song", seed: 4242, facts: { key: "a minor" } };
  assert.deepEqual(entrySprite(entry), spriteFor(4242, { tonic: 9, minor: true }));
  assert.deepEqual(entrySprite({ id: "y", t: "No facts", seed: 7 }), spriteFor(7));
});

test("drawing paints one square per colored cell, at the scale and offset given", () => {
  /** @type {Array<[string, number, number, number, number]>} */
  const squares = [];
  const context = {
    fillStyle: "",
    fillRect(/** @type {number[]} */ ...box) {
      squares.push([this.fillStyle, box[0], box[1], box[2], box[3]]);
    },
  };
  const sprite = spriteFor(31, { tonic: 4, minor: false });
  drawSprite(/** @type {any} */ (context), sprite, 10, 20, 3);
  const colored = cellsOf(sprite.grid).filter(({ cell }) => cell !== CELL.EMPTY);
  assert.equal(squares.length, colored.length);
  const { x, y, cell } = colored[0];
  assert.deepEqual(squares[0], [sprite.colors[cell], 10 + x * 3, 20 + y * 3, 3, 3]);
});
