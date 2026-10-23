// @ts-check
// Tests for ui/texture-cache.js: the shelf's memory of record faces, so turning a page back and
// forth does not draw the same textures again. It is a small least-recently-used cache.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createTextureCache } from "../src/ui/texture-cache.js";

test("a face is made once and then remembered", () => {
  let made = 0;
  const cache = createTextureCache({ limit: 3, make: (key) => ({ key, n: ++made }) });
  const first = cache.get("a");
  assert.equal(cache.get("a"), first);
  assert.equal(made, 1);
});

test("the face used longest ago is let go first, and the owner is told", () => {
  /** @type {string[]} */
  const released = [];
  const cache = createTextureCache({ limit: 2, make: (key) => ({ key }), release: (face) => released.push(face.key) });
  cache.get("a");
  cache.get("b");
  cache.get("a"); // a is fresh again
  cache.get("c");
  assert.deepEqual(released, ["b"]);
  assert.equal(cache.has("a"), true);
  assert.equal(cache.has("b"), false);
  assert.equal(cache.size, 2);
});

test("a face asked for again after it was let go is made again", () => {
  let made = 0;
  const cache = createTextureCache({ limit: 1, make: () => ({ n: ++made }) });
  cache.get("a");
  cache.get("b");
  cache.get("a");
  assert.equal(made, 3);
});

test("faces marked in use are kept even when the cache is over its limit", () => {
  /** @type {string[]} */
  const released = [];
  const cache = createTextureCache({ limit: 1, make: (key) => ({ key }), release: (face) => released.push(face.key) });
  const a = cache.get("a");
  cache.hold(a);
  cache.get("b");
  cache.get("c");
  assert.equal(cache.has("a"), true, "a is on screen");
  assert.deepEqual(released, ["b"]);
  cache.unhold(a);
  cache.get("d");
  assert.equal(cache.has("a"), false, "once off screen it can go");
});

test("clear lets every face go", () => {
  /** @type {string[]} */
  const released = [];
  const cache = createTextureCache({ limit: 5, make: (key) => ({ key }), release: (face) => released.push(face.key) });
  cache.get("a");
  cache.get("b");
  cache.clear();
  assert.deepEqual(released.sort(), ["a", "b"]);
  assert.equal(cache.size, 0);
});
