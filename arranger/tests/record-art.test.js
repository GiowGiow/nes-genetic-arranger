// @ts-check
// Tests for ui/record-art.js: the face of a vinyl record, drawn the same for the shelf and for
// the turntable. A recording stand-in for the canvas context lets the test see what is painted.

import assert from "node:assert/strict";
import { test } from "node:test";

import { RECORD_FACE_SIZE, SPRITE_SCALE, drawRecordFace } from "../src/ui/record-art.js";
import { entrySprite } from "../src/ui/sprites.js";

/** A canvas whose 2D context records every call and every fill color in order. */
function recordingCanvas() {
  /** @type {Array<{call: string, args: any[], fill: string}>} */
  const calls = [];
  const state = { fillStyle: "", strokeStyle: "", lineWidth: 1 };
  const context = new Proxy(state, {
    get(target, name) {
      if (name in target) return target[/** @type {keyof typeof target} */ (name)];
      return (/** @type {any[]} */ ...args) => calls.push({ call: String(name), args, fill: target.fillStyle });
    },
    set(target, name, value) {
      /** @type {any} */ (target)[name] = value;
      return true;
    },
  });
  return { width: 0, height: 0, getContext: () => context, calls };
}

const entry = { seed: 4242, facts: { key: "a minor" } };

test("a record face is a 128 pixel square, so the shelf and the turntable show the same texture", () => {
  const canvas = recordingCanvas();
  const drawn = drawRecordFace(/** @type {any} */ (canvas), entry);

  assert.equal(RECORD_FACE_SIZE, 128);
  assert.equal(canvas.width, 128);
  assert.equal(canvas.height, 128);
  assert.equal(drawn, canvas, "the canvas is returned, to hand to a texture");
});

test("it paints a dark disc first, then the grooves, a highlight, the label in the sprite's color and the black spindle hole", () => {
  const canvas = recordingCanvas();
  drawRecordFace(/** @type {any} */ (canvas), entry);

  const arcs = canvas.calls.filter((entryCall) => entryCall.call === "arc");
  assert.deepEqual(arcs[0].args.slice(0, 3), [64, 64, 64], "the disc is as big as the canvas");
  assert.equal(canvas.calls.find((entryCall) => entryCall.call === "fill")?.fill, "#0b0d14");
  const fills = canvas.calls.filter((entryCall) => entryCall.call === "fill");
  assert.equal(fills.at(-2)?.fill, entrySprite(entry).label, "the label disc takes the sprite's label color");
  assert.equal(fills.at(-1)?.fill, "#000000", "the spindle hole is last");
  assert.ok(arcs.some((arc) => arc.args[2] === 28), "the label is a disc of radius 28");
});

test("the sprite sits centered on the label, three canvas pixels to a cell", () => {
  const canvas = recordingCanvas();
  drawRecordFace(/** @type {any} */ (canvas), entry);

  assert.equal(SPRITE_SCALE, 3);
  const squares = canvas.calls.filter((entryCall) => entryCall.call === "fillRect");
  const sprite = entrySprite(entry);
  const painted = sprite.grid.flat().filter((cell) => sprite.colors[cell]).length;
  assert.equal(squares.length, painted);
  // The 16 cell grid is 48 pixels wide: its cells all fall inside 24 pixels either side of the centre.
  assert.ok(squares.every((square) => square.args[0] >= 64 - 24 && square.args[0] + 3 <= 64 + 24));
  assert.ok(squares.every((square) => square.args[2] === 3 && square.args[3] === 3));
});

test("the same song gives the same face twice", () => {
  const first = recordingCanvas();
  const second = recordingCanvas();
  drawRecordFace(/** @type {any} */ (first), entry);
  drawRecordFace(/** @type {any} */ (second), entry);

  assert.deepEqual(first.calls, second.calls);
});
