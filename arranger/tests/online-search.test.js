// @ts-check
// Tests for core/online-search.js: when the search box asks the online sources and what it
// tells the shelf while they answer. The sources are scripted and the clock is moved by hand.

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEBOUNCE_MS, MIN_QUERY_LENGTH, TIMEOUT_MS, createOnlineSearch } from "../src/core/online-search.js";
import { createManualClock } from "./fake-dom.js";

/** A result of a source. @param {string} source @param {string} id */
const result = (source, id) => ({ source, id, title: `${source} ${id}`, composer: "", license: "", format: /** @type {const} */ ("midi"), page: "", open: `https://x.example/${id}.mid` });

/**
 * A source whose answers the test decides: `run` returns a promise that the test settles.
 * @param {string} id
 */
function scriptedSource(id) {
  /** @type {Array<{query: string, signal: AbortSignal, resolve: (results: any[]) => void, reject: (error: Error) => void}>} */
  const asked = [];
  return {
    id,
    name: id.toUpperCase(),
    asked,
    run: (/** @type {string} */ query, /** @type {{signal: AbortSignal}} */ { signal }) =>
      new Promise((resolve, reject) => asked.push({ query, signal, resolve, reject })),
  };
}

/** @param {{online?: boolean}} [options] */
function setUp({ online = true } = {}) {
  const clock = createManualClock();
  const a = scriptedSource("alpha");
  const b = scriptedSource("beta");
  /** @type {any[]} */
  const states = [];
  const state = { online };
  const search = createOnlineSearch({
    sources: [a, b],
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isOnline: () => state.online,
    onChange: (next) => states.push(next),
  });
  const last = () => states.at(-1);
  return { clock, a, b, search, states, last, state };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("nothing is asked until the visitor pauses typing", () => {
  const { clock, a, search } = setUp();
  search.query("arctic");
  clock.advance(DEBOUNCE_MS - 1);
  assert.equal(a.asked.length, 0);
  search.query("arctic m");
  clock.advance(DEBOUNCE_MS - 1);
  assert.equal(a.asked.length, 0, "another key starts the pause again");
  clock.advance(1);
  assert.equal(a.asked.length, 1);
  assert.equal(a.asked[0].query, "arctic m");
});

test("a query under two letters asks nothing and clears the online state", () => {
  const { clock, a, search, last } = setUp();
  search.query("a");
  clock.advance(DEBOUNCE_MS);
  assert.equal(a.asked.length, 0);
  assert.equal(MIN_QUERY_LENGTH, 2);
  assert.equal(last().active, false);
});

test("each source is asked once per query, together, and the state says which are still pending", async () => {
  const { clock, a, b, search, last } = setUp();
  search.query("monkeys");
  clock.advance(DEBOUNCE_MS);
  assert.equal(a.asked.length, 1);
  assert.equal(b.asked.length, 1);
  assert.deepEqual(last().pending, ["ALPHA", "BETA"]);
  assert.equal(last().searching, true);
  assert.equal(last().active, true);
  a.asked[0].resolve([result("alpha", "1")]);
  await settle();
  assert.deepEqual(last().pending, ["BETA"]);
  assert.equal(last().searching, true);
  b.asked[0].resolve([]);
  await settle();
  assert.deepEqual(last().pending, []);
  assert.equal(last().searching, false);
});

test("results are listed in the sources' order, whichever answers first", async () => {
  const { clock, a, b, search, last } = setUp();
  search.query("monkeys");
  clock.advance(DEBOUNCE_MS);
  b.asked[0].resolve([result("beta", "b1")]);
  await settle();
  a.asked[0].resolve([result("alpha", "a1"), result("alpha", "a2")]);
  await settle();
  assert.deepEqual(last().results.map((/** @type {any} */ item) => item.id), ["a1", "a2", "b1"]);
});

test("a new query abandons the old one: its requests are aborted and its late answers ignored", async () => {
  const { clock, a, search, last } = setUp();
  search.query("monkeys");
  clock.advance(DEBOUNCE_MS);
  const old = a.asked[0];
  search.query("monkeys fake");
  clock.advance(DEBOUNCE_MS);
  assert.equal(old.signal.aborted, true);
  old.resolve([result("alpha", "stale")]);
  await settle();
  assert.deepEqual(last().results, []);
  assert.equal(last().query, "monkeys fake");
});

test("typing again while waiting for the pause aborts a search already running", () => {
  const { clock, a, search } = setUp();
  search.query("monkeys");
  clock.advance(DEBOUNCE_MS);
  search.query("monkeys f");
  assert.equal(a.asked[0].signal.aborted, true);
});

test("the same query again is answered from memory, with no new requests", async () => {
  const { clock, a, b, search, last } = setUp();
  search.query("monkeys");
  clock.advance(DEBOUNCE_MS);
  a.asked[0].resolve([result("alpha", "1")]);
  b.asked[0].resolve([]);
  await settle();
  search.query("other words");
  clock.advance(DEBOUNCE_MS);
  search.query("Monkeys ");
  clock.advance(DEBOUNCE_MS);
  assert.equal(a.asked.length, 2, "monkeys and other words; the third was remembered");
  assert.deepEqual(last().results.map((/** @type {any} */ item) => item.id), ["1"]);
  assert.equal(last().searching, false);
});

test("a source that fails is named with a reason, the others still show their results", async () => {
  const { clock, a, b, search, last } = setUp();
  search.query("monkeys");
  clock.advance(DEBOUNCE_MS);
  a.asked[0].reject(new Error("HTTP 429"));
  b.asked[0].resolve([result("beta", "b1")]);
  await settle();
  assert.deepEqual(last().failed, [{ id: "alpha", name: "ALPHA", reason: "HTTP 429" }]);
  assert.deepEqual(last().results.map((/** @type {any} */ item) => item.id), ["b1"]);
  assert.equal(last().searching, false);
});

test("a failure is not remembered: retry asks only the sources that failed", async () => {
  const { clock, a, b, search, last } = setUp();
  search.query("monkeys");
  clock.advance(DEBOUNCE_MS);
  a.asked[0].reject(new Error("network"));
  b.asked[0].resolve([result("beta", "b1")]);
  await settle();
  search.retry();
  assert.equal(a.asked.length, 2);
  assert.equal(b.asked.length, 1, "BETA answered; it is not asked again");
  assert.deepEqual(last().pending, ["ALPHA"]);
  a.asked[1].resolve([result("alpha", "a1")]);
  await settle();
  assert.deepEqual(last().failed, []);
  assert.deepEqual(last().results.map((/** @type {any} */ item) => item.id), ["a1", "b1"]);
});

test("a source that is silent for too long is given up on, with a reason that says so", async () => {
  const { clock, a, b, search, last } = setUp();
  search.query("monkeys");
  clock.advance(DEBOUNCE_MS);
  b.asked[0].resolve([]);
  await settle();
  clock.advance(TIMEOUT_MS);
  await settle();
  assert.equal(a.asked[0].signal.aborted, true);
  assert.equal(last().failed[0].id, "alpha");
  assert.match(last().failed[0].reason, /too long/);
  assert.equal(last().searching, false);
});

test("offline, nothing is asked and the state says so", () => {
  const { clock, a, search, last } = setUp({ online: false });
  search.query("monkeys");
  clock.advance(DEBOUNCE_MS);
  assert.equal(a.asked.length, 0);
  assert.equal(last().offline, true);
  assert.equal(last().searching, false);
  assert.equal(last().active, true);
});

test("cancel stops a pending pause and a search under way", () => {
  const { clock, a, search, last } = setUp();
  search.query("monkeys");
  search.cancel();
  clock.advance(DEBOUNCE_MS);
  assert.equal(a.asked.length, 0);
  search.query("monkeys");
  clock.advance(DEBOUNCE_MS);
  search.cancel();
  assert.equal(a.asked[0].signal.aborted, true);
  assert.equal(last().active, false);
});

test("a source that needs no request answers at once and is never shown as pending", () => {
  const clock = createManualClock();
  const link = { id: "link", name: "LINK", instant: () => [result("link", "x")], run: () => Promise.reject(new Error("never asked")) };
  /** @type {any[]} */
  const states = [];
  const search = createOnlineSearch({ sources: [link], setTimer: clock.setTimer, clearTimer: clock.clearTimer, isOnline: () => true, onChange: (state) => states.push(state) });
  search.query("monkeys");
  clock.advance(DEBOUNCE_MS);
  assert.deepEqual(states.at(-1).pending, []);
  assert.equal(states.at(-1).searching, false);
  assert.deepEqual(states.at(-1).results.map((/** @type {any} */ item) => item.id), ["x"]);
});
