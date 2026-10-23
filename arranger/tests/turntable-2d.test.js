// @ts-check
// Tests for the pure part of ui/turntable-2d.js: how the platter's plane (scene units, seen from
// above) fits a canvas, and how a point of the canvas maps back for the drag. The drawing itself
// is checked in the browser.

import assert from "node:assert/strict";
import { test } from "node:test";

import { VIEW_BOUNDS, fitView, planeToCanvas, canvasToPlane } from "../src/ui/turntable-2d.js";

test("the whole turntable fits the canvas, centered, with the same scale in both directions", () => {
  const view = fitView(660, 550);
  const left = planeToCanvas(view, { x: VIEW_BOUNDS.minX, z: VIEW_BOUNDS.minZ });
  const right = planeToCanvas(view, { x: VIEW_BOUNDS.maxX, z: VIEW_BOUNDS.maxZ });

  assert.ok(left.x >= -1e-9 && left.y >= -1e-9);
  assert.ok(right.x <= 660 + 1e-9 && right.y <= 550 + 1e-9);
  assert.ok(Math.abs(left.x - (660 - right.x)) < 1e-6 || Math.abs(left.y - (550 - right.y)) < 1e-6, "centered on one axis at least");
});

test("a wide canvas leaves room at the sides and a tall one above and below", () => {
  const wide = fitView(1000, 300);
  const tall = fitView(300, 1000);

  assert.ok(wide.scale === 300 / (VIEW_BOUNDS.maxZ - VIEW_BOUNDS.minZ));
  assert.ok(tall.scale === 300 / (VIEW_BOUNDS.maxX - VIEW_BOUNDS.minX));
});

test("a point of the canvas maps back to the plane it came from", () => {
  const view = fitView(480, 400);
  for (const point of [{ x: 0, z: 0 }, { x: 1.3, z: -0.95 }, { x: -0.7, z: 0.9 }]) {
    const back = canvasToPlane(view, planeToCanvas(view, point));
    assert.ok(Math.abs(back.x - point.x) < 1e-9 && Math.abs(back.z - point.z) < 1e-9);
  }
});

test("scene z grows toward the viewer, so it grows down the canvas", () => {
  const view = fitView(480, 400);
  assert.ok(planeToCanvas(view, { x: 0, z: 1 }).y > planeToCanvas(view, { x: 0, z: -1 }).y);
  assert.ok(planeToCanvas(view, { x: 1, z: 0 }).x > planeToCanvas(view, { x: -1, z: 0 }).x);
});
