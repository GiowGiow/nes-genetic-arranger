// @ts-check
// Tests for ui/turntable-view.js: the Result's record player as a page element. The renderers
// (three.js scene, 2D canvas) are stand-ins here; the view's own job is tested: lazy loading of
// the 3D scene with a 2D fallback, the slider semantics for assistive technology, drawing only
// when it matters, and a drag on the arm or record that seeks.

import assert from "node:assert/strict";
import { test } from "node:test";

import { armAngleForProgress, armTip } from "../src/ui/turntable-geometry.js";
import { createTurntable } from "../src/ui/turntable-view.js";
import { FakeDocument } from "./fake-dom.js";

/** A renderer stand-in that records what it was asked, and maps the pointer 1:1 onto the plane. */
function fakeRenderer(/** @type {string} */ name) {
  const renderer = {
    name,
    frames: /** @type {any[]} */ ([]),
    records: /** @type {any[]} */ ([]),
    sizes: /** @type {any[]} */ ([]),
    disposed: false,
    canvas: null,
    resize(/** @type {number} */ width, /** @type {number} */ height, /** @type {number} */ ratio) {
      renderer.sizes.push([width, height, ratio]);
    },
    setRecord(/** @type {any} */ face) {
      renderer.records.push(face);
    },
    draw(/** @type {any} */ frame) {
      renderer.frames.push(frame);
    },
    planePoint(/** @type {number} */ x, /** @type {number} */ y) {
      return { x, z: y };
    },
    dispose() {
      renderer.disposed = true;
    },
  };
  return renderer;
}

/** The view on a fake page, with a clock the test sets and frames the test runs. */
function harness(/** @type {{duration?: number, playing?: boolean, loadScene?: () => Promise<any>, visible?: () => boolean, reducedMotion?: boolean}} */ options = {}) {
  const document = new FakeDocument();
  const container = document.createElement("div");
  const state = { time: 0, duration: options.duration ?? 60, playing: options.playing ?? false, visible: true };
  /** @type {number[]} */
  const seeks = [];
  /** @type {Array<(time: number) => void>} */
  let pending = [];
  /** @type {Array<() => void>} */
  const idle = [];
  const flat = fakeRenderer("2d");
  const scene = fakeRenderer("3d");
  let loaded = 0;
  const view = createTurntable(/** @type {any} */ (container), {
    clock: { time: () => state.time, duration: () => state.duration, playing: () => state.playing },
    seek: (seconds) => seeks.push(seconds),
    loadScene: options.loadScene ?? (async () => {
      loaded += 1;
      return { createTurntableScene: () => scene };
    }),
    create2d: () => flat,
    drawFace: (canvas) => canvas,
    observeSize: (_element, onSize) => {
      onSize({ width: 400, height: 300 });
      return () => {};
    },
    isVisible: options.visible ?? (() => state.visible),
    reducedMotion: options.reducedMotion ?? false,
    schedule: (run) => {
      pending.push(run);
      return pending.length;
    },
    cancel: () => {},
    idle: (run) => idle.push(run),
  });
  return {
    document,
    container,
    stage: /** @type {any} */ (container.children[0]),
    state,
    seeks,
    flat,
    scene,
    view,
    idle,
    loads: () => loaded,
    /** Run the frames that are waiting, each at the next 100 ms. */
    frame(/** @type {number} */ at = 100) {
      const run = pending;
      pending = [];
      run.forEach((callback) => callback(at));
      return run.length;
    },
    waiting: () => pending.length,
  };
}

const entry = { seed: 7, facts: { key: "a minor" } };

test("the view is a slider for assistive technology: it names the position and the length, and can be focused", () => {
  const { stage, state, view, frame } = harness({ duration: 51 });
  state.time = 12.4;
  view.wake();
  frame();

  assert.equal(stage.getAttribute("role"), "slider");
  assert.equal(stage.getAttribute("tabindex"), "0");
  assert.equal(stage.getAttribute("aria-valuemin"), "0");
  assert.equal(stage.getAttribute("aria-valuemax"), "51");
  assert.equal(stage.getAttribute("aria-valuenow"), "12");
  assert.equal(stage.getAttribute("aria-valuetext"), "0:12 of 0:51");
});

test("with no song it says so, and the arm is parked lifted", () => {
  const { stage, flat, view, frame } = harness({ duration: 0 });
  view.wake();
  frame();

  assert.equal(stage.getAttribute("aria-valuetext"), "No song loaded");
  const last = flat.frames.at(-1);
  assert.ok(last.lift > 0.5, "the arm is lifted");
});

test("it starts with the 2D renderer and loads the 3D scene only when the browser is idle", async () => {
  const { loads, idle, flat, scene } = harness();

  assert.equal(loads(), 0, "nothing is loaded at creation");
  assert.equal(flat.disposed, false);
  idle.forEach((run) => run());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(loads(), 1);
  assert.equal(flat.disposed, true, "the 2D renderer gives way to the 3D scene");
  assert.equal(scene.disposed, false);
});

test("if the 3D scene cannot load, the 2D renderer stays", async () => {
  const { idle, flat, view } = harness({ loadScene: async () => { throw new Error("no WebGL"); } });

  idle.forEach((run) => run());
  await new Promise((resolve) => setTimeout(resolve));
  assert.equal(flat.disposed, false);
  assert.equal(view.mode(), "2d");
});

test("when the scene module loads but cannot make a WebGL context, the 2D renderer stays", async () => {
  const { idle, flat, view } = harness({
    loadScene: async () => ({
      createTurntableScene() {
        throw new Error("WebGL 2 is not available");
      },
    }),
  });

  idle.forEach((run) => run());
  await new Promise((resolve) => setTimeout(resolve));
  assert.equal(flat.disposed, false);
  assert.equal(view.mode(), "2d");
});

test("the record on the platter is the song's face, handed to the renderer", () => {
  const { flat, view, frame } = harness();
  view.setRecord(entry);
  frame();

  assert.equal(flat.records.length >= 1, true);
  assert.notEqual(flat.records.at(-1), null);
  view.setRecord(null);
  assert.equal(flat.records.at(-1), null, "no song, no record");
});

test("a paused view draws once and then stops asking for frames", () => {
  const { view, frame, flat, waiting } = harness();
  view.wake();
  for (let step = 0; step < 40; step += 1) frame(100 + step * 100);

  assert.ok(flat.frames.length >= 1);
  assert.equal(waiting(), 0, "idle: the loop has stopped");
});

test("while playing the platter turns and the arm follows the position; the loop goes on", () => {
  const { state, view, frame, flat, waiting } = harness({ playing: true });
  view.wake();
  state.time = 5;
  for (let step = 0; step < 20; step += 1) frame(100 + step * 40);
  const early = flat.frames.at(-1);
  state.time = 40;
  for (let step = 20; step < 60; step += 1) frame(100 + step * 40);
  const late = flat.frames.at(-1);

  assert.ok(waiting() > 0, "still looping while it plays");
  assert.ok(late.spinAngle !== early.spinAngle, "the record turned");
  assert.ok(late.armAngle > early.armAngle, "the arm moved inward");
  assert.ok(Math.abs(late.armAngle - armAngleForProgress(40 / 60)) < 0.02, "and ended near the right place");
});

test("under reduced motion the record does not spin, but the arm still follows the position", () => {
  const { state, view, frame, flat } = harness({ playing: true, reducedMotion: true });
  state.time = 30;
  view.wake();
  for (let step = 0; step < 30; step += 1) frame(100 + step * 40);

  assert.equal(flat.frames.at(-1).spinAngle, 0);
  assert.ok(Math.abs(flat.frames.at(-1).armAngle - armAngleForProgress(0.5)) < 0.02);
});

test("a hidden view draws nothing", () => {
  const { state, view, frame, flat } = harness({ playing: true, visible: () => false });
  state.time = 5;
  view.wake();
  for (let step = 0; step < 10; step += 1) frame(100 + step * 40);

  assert.equal(flat.frames.length, 0);
});

test("pressing the record seeks to where the arm aimed at the pointer would drop its needle", () => {
  const { stage, seeks } = harness({ duration: 100 });
  const aimed = armTip(armAngleForProgress(0.3));
  stage.dispatch("pointerdown", { clientX: aimed.x, clientY: aimed.z, pointerId: 1, preventDefault() {} });

  assert.equal(seeks.length, 1);
  assert.ok(Math.abs(seeks[0] - 30) < 1e-6, `${seeks[0]}`);
});

test("dragging keeps seeking until the pointer is released", () => {
  const { stage, seeks } = harness({ duration: 100 });
  const at = (/** @type {number} */ progress) => armTip(armAngleForProgress(progress));
  stage.dispatch("pointerdown", { clientX: at(0.2).x, clientY: at(0.2).z, pointerId: 1, preventDefault() {} });
  stage.dispatch("pointermove", { clientX: at(0.5).x, clientY: at(0.5).z, pointerId: 1, preventDefault() {} });
  stage.dispatch("pointerup", { pointerId: 1 });
  const count = seeks.length;
  stage.dispatch("pointermove", { clientX: at(0.9).x, clientY: at(0.9).z, pointerId: 1, preventDefault() {} });

  assert.ok(Math.abs(seeks.at(-1) - 50) < 1e-6);
  assert.equal(seeks.length, count, "moves after the release do nothing");
});

test("a press away from the arm and the record does not seek", () => {
  const { stage, seeks } = harness({ duration: 100 });
  stage.dispatch("pointerdown", { clientX: -2, clientY: 1.3, pointerId: 1, preventDefault() {} });

  assert.deepEqual(seeks, []);
});

test("with no song a press does nothing", () => {
  const { stage, seeks } = harness({ duration: 0 });
  stage.dispatch("pointerdown", { clientX: 0, clientY: 0, pointerId: 1, preventDefault() {} });

  assert.deepEqual(seeks, []);
});

test("Home and End jump to the ends of the song; the arrow keys are left to the page's own seek keys", () => {
  const { stage, seeks } = harness({ duration: 80 });
  /** @type {string[]} */
  const stopped = [];
  stage.dispatch("keydown", { key: "End", preventDefault() { stopped.push("End"); } });
  stage.dispatch("keydown", { key: "Home", preventDefault() {} });
  stage.dispatch("keydown", { key: "ArrowRight", preventDefault() { stopped.push("ArrowRight"); } });

  assert.deepEqual(seeks, [80, 0]);
  assert.deepEqual(stopped, ["End"], "the arrow is not handled here, so the page's key handler gets it");
});

test("disposing stops the loop and gives the renderer back", () => {
  const { view, flat } = harness({ playing: true });
  view.wake();
  view.dispose();

  assert.equal(flat.disposed, true);
});
