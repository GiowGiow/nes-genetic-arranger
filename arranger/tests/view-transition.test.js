// @ts-check
// Tests for ui/view-transition.js: tab and view changes cross-fade and slide where the browser
// supports the View Transitions API, and on a desktop with motion allowed only. Elsewhere the
// change happens at once (the CSS panel-in animation then does the entrance). Changes asked for in
// the same turn share one transition, so a tab change plus a view change is one animation.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createTransitioner, shouldUseTransitions, slideDirection } from "../src/ui/view-transition.js";

/** A page with a View Transitions API that records its use. */
function fakePage(/** @type {{supported?: boolean}} */ { supported = true } = {}) {
  const root = { dataset: /** @type {Record<string, string>} */ ({}) , classList: { names: new Set(), add(/** @type {string} */ n) { this.names.add(n); }, remove(/** @type {string} */ n) { this.names.delete(n); } } };
  const calls = { started: 0, ran: 0 };
  /** @type {Array<() => void>} */
  const finishers = [];
  const document = {
    documentElement: root,
    startViewTransition: supported
      ? (/** @type {() => void} */ update) => {
          calls.started += 1;
          calls.ran += 1;
          update();
          return { finished: new Promise((resolve) => finishers.push(() => resolve(undefined))) };
        }
      : undefined,
  };
  return { document, root, calls, finishAll: () => finishers.splice(0).forEach((finish) => finish()) };
}

const queue = () => new Promise((resolve) => queueMicrotask(() => resolve(undefined)));

test("transitions are used only where the browser has them, motion is allowed and the pointer is not coarse", () => {
  assert.equal(shouldUseTransitions({ supported: true, reducedMotion: false, coarsePointer: false }), true);
  assert.equal(shouldUseTransitions({ supported: false, reducedMotion: false, coarsePointer: false }), false);
  assert.equal(shouldUseTransitions({ supported: true, reducedMotion: true, coarsePointer: false }), false);
  assert.equal(shouldUseTransitions({ supported: true, reducedMotion: false, coarsePointer: true }), false, "a phone's cards have blur: snapshots cost memory");
});

test("the slide follows the order of the tabs: to a later tab forward, to an earlier tab back", () => {
  assert.equal(slideDirection(0, 2), "forward");
  assert.equal(slideDirection(2, 0), "back");
  assert.equal(slideDirection(1, 1), "none");
});

test("with transitions off, the change is made at once, before run() returns", () => {
  const page = fakePage({ supported: false });
  const transitions = createTransitioner({ document: /** @type {any} */ (page.document), reducedMotion: () => false, coarsePointer: () => false });
  let done = false;

  transitions.run(() => (done = true), "forward");

  assert.equal(done, true);
  assert.equal(page.calls.started, 0);
});

test("under reduced motion the change is made at once, even where the API exists", () => {
  const page = fakePage();
  const transitions = createTransitioner({ document: /** @type {any} */ (page.document), reducedMotion: () => true, coarsePointer: () => false });
  let done = false;

  transitions.run(() => (done = true), "forward");

  assert.equal(done, true);
  assert.equal(page.calls.started, 0);
});

test("with transitions on, the change runs inside one view transition, with its direction set for the CSS", async () => {
  const page = fakePage();
  const transitions = createTransitioner({ document: /** @type {any} */ (page.document), reducedMotion: () => false, coarsePointer: () => false });
  let done = false;

  transitions.run(() => (done = true), "forward");
  assert.equal(done, false, "it waits a turn to join other changes");
  await queue();

  assert.equal(done, true);
  assert.equal(page.calls.started, 1);
  assert.equal(page.root.dataset.slide, "forward");
  page.finishAll();
  await queue();
  assert.equal(page.root.dataset.slide, undefined, "the direction is cleared when the transition ends");
});

test("changes asked for in the same turn share one transition, and the first direction that is not none wins", async () => {
  const page = fakePage();
  const transitions = createTransitioner({ document: /** @type {any} */ (page.document), reducedMotion: () => false, coarsePointer: () => false });
  /** @type {string[]} */
  const order = [];

  transitions.run(() => order.push("view"), "none");
  transitions.run(() => order.push("tab"), "back");
  await queue();

  assert.deepEqual(order, ["view", "tab"], "in the order they were asked");
  assert.equal(page.calls.started, 1);
  assert.equal(page.root.dataset.slide, "back");
});

test("a change that throws does not stop the others in its transition", async () => {
  const page = fakePage();
  const transitions = createTransitioner({ document: /** @type {any} */ (page.document), reducedMotion: () => false, coarsePointer: () => false });
  /** @type {string[]} */
  const order = [];

  transitions.run(() => {
    throw new Error("one panel failed");
  }, "none");
  transitions.run(() => order.push("second"), "none");
  await queue();

  assert.deepEqual(order, ["second"]);
});

test("the page is marked when transitions are on, so the CSS entrance animation steps aside for the browser's", () => {
  const page = fakePage();
  createTransitioner({ document: /** @type {any} */ (page.document), reducedMotion: () => false, coarsePointer: () => false });
  assert.equal(page.root.classList.names.has("vt-on"), true);

  const off = fakePage({ supported: false });
  createTransitioner({ document: /** @type {any} */ (off.document), reducedMotion: () => false, coarsePointer: () => false });
  assert.equal(off.root.classList.names.has("vt-on"), false);
});
