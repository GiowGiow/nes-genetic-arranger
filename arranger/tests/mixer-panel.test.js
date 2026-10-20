// @ts-check
// Tests for ui/mixer-panel.js: the four level controls under the player (spec 005, story 1,
// FR-001).
//
// Node has no DOM, so the panel is built in a small fake document that keeps elements,
// attributes, text and listeners. The tests read as the panel's rules: one row per channel with
// its name and color, a slider from Off (-60 dB) to +12 dB that says its value in dB, a mute
// toggle per channel and one Reset; every change reports the full levels.

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_LEVELS, MAX_DB, MIN_DB, clampLevels } from "../src/audio/mixer.js";
import { createMixerPanel, formatLevel } from "../src/ui/mixer-panel.js";

/** @typedef {import("../src/audio/mixer.js").Levels} Levels */

/** An element of the fake document: children, attributes, text, inline style and listeners. */
class FakeElement {
  /**
   * @param {string} tagName
   * @param {FakeDocument} ownerDocument
   */
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    /** @type {FakeElement[]} */
    this.children = [];
    /** @type {Map<string, string>} */
    this.attributes = new Map();
    /** @type {Record<string, Array<(event: object) => void>>} */
    this.listeners = {};
    this.ownText = "";
    this.className = "";
    this.id = "";
    this.value = "";
    /** @type {Map<string, string>} */
    const properties = new Map();
    this.style = {
      /** @param {string} name @param {string} value */
      setProperty: (name, value) => void properties.set(name, value),
      /** @param {string} name */
      getPropertyValue: (name) => properties.get(name) ?? "",
    };
  }
  /** @param {...FakeElement} nodes */
  append(...nodes) {
    for (const node of nodes) {
      assert.ok(node instanceof FakeElement, "the panel appends elements, not loose text");
      this.children.push(node);
    }
  }
  /** @param {FakeElement} node */
  appendChild(node) {
    this.append(node);
    return node;
  }
  /** @param {string} name @param {string} value */
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  /** @param {string} name */
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  /** @param {string} type @param {(event: object) => void} listener */
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  /** @param {string} type */
  dispatch(type) {
    for (const listener of this.listeners[type] ?? []) listener({ type, target: this, currentTarget: this });
  }
  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }
  set textContent(text) {
    this.ownText = String(text);
    this.children = [];
  }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    return { contains: (/** @type {string} */ name) => names().includes(name) };
  }
}

class FakeDocument {
  /** @param {string} tagName */
  createElement(tagName) {
    return new FakeElement(tagName, this);
  }
}

/**
 * Every element under `root` (itself included) that passes `predicate`, in document order.
 * @param {FakeElement} root
 * @param {(element: FakeElement) => boolean} predicate
 * @returns {FakeElement[]}
 */
function all(root, predicate) {
  const found = predicate(root) ? [root] : [];
  for (const child of root.children) found.push(...all(child, predicate));
  return found;
}

/**
 * @param {FakeElement} root
 * @param {(element: FakeElement) => boolean} predicate
 */
function one(root, predicate) {
  const [element] = all(root, predicate);
  assert.ok(element, "element found");
  return element;
}

const hasClass = (/** @type {string} */ name) => (/** @type {FakeElement} */ element) => element.classList.contains(name);

/**
 * A panel in a fake container, the levels its onChange reported, and its rows by channel.
 * @param {Levels} [levels]
 */
function panelOf(levels) {
  const container = new FakeDocument().createElement("div");
  /** @type {Levels[]} */
  const reported = [];
  const panel = createMixerPanel(/** @type {any} */ (container), { levels, onChange: (next) => reported.push(next) });
  const rows = Object.fromEntries(
    all(container, (element) => element.getAttribute("data-channel") !== null).map((row) => [row.getAttribute("data-channel"), row]),
  );
  /** @param {string} channel */
  const slider = (channel) => one(rows[channel], (element) => element.tagName === "INPUT");
  /** @param {string} channel */
  const mute = (channel) => one(rows[channel], hasClass("mixer-mute"));
  /** @param {string} channel */
  const valueText = (channel) => one(rows[channel], hasClass("mixer-value"));
  const reset = one(container, hasClass("mixer-reset"));
  return { container, panel, reported, rows, slider, mute, valueText, reset };
}

/** @type {Levels} */
const SOME_LEVELS = { P1: 0, P2: -1, TR: 4.5, NO: MIN_DB, muted: { P1: false, P2: true, TR: false, NO: false } };

test("a level reads as signed dB with a real minus sign, and the bottom of the scale reads Off", () => {
  assert.equal(formatLevel(4), "+4 dB");
  assert.equal(formatLevel(-1), "−1 dB");
  assert.equal(formatLevel(0), "0 dB");
  assert.equal(formatLevel(4.5), "+4.5 dB");
  assert.equal(formatLevel(-0.5), "−0.5 dB");
  assert.equal(formatLevel(MAX_DB), "+12 dB");
  assert.equal(formatLevel(MIN_DB), "Off");
});

test("the panel has four rows, Melody, Harmony, Bass and Drums, each with its channel and its color", () => {
  const { rows, container } = panelOf();
  assert.deepEqual(Object.keys(rows), ["P1", "P2", "TR", "NO"]);
  const expected = { P1: ["Melody", "--p1"], P2: ["Harmony", "--p2"], TR: ["Bass", "--tr"], NO: ["Drums", "--no"] };
  for (const [channel, [name, color]] of Object.entries(expected)) {
    const row = rows[channel];
    const label = one(row, (element) => element.tagName === "LABEL");
    assert.match(label.textContent, new RegExp(`^${name}\\s*${channel}$`), `${channel} label`);
    const swatch = one(label, hasClass("mixer-swatch"));
    assert.equal(swatch.getAttribute("aria-hidden"), "true");
    assert.equal(row.style.getPropertyValue("--c"), `var(${color})`, `${channel} color`);
  }
  assert.equal(container.children.length, 1, "one root element");
  assert.equal(container.children[0].getAttribute("role"), "group");
  assert.ok(container.children[0].getAttribute("aria-label"), "the group is named");
  assert.ok(!container.textContent.includes("·"), "labeled values, no dot-separated text");
});

test("each slider is labeled by its row and runs from -60 dB to +12 dB in 0.5 dB steps", () => {
  const { rows, slider } = panelOf();
  const ids = new Set();
  for (const channel of Object.keys(rows)) {
    const input = slider(channel);
    const label = one(rows[channel], (element) => element.tagName === "LABEL");
    assert.equal(input.type, "range");
    assert.deepEqual([input.min, input.max, input.step], [String(MIN_DB), String(MAX_DB), "0.5"]);
    assert.ok(input.id, `${channel} has an id`);
    assert.equal(label.htmlFor, input.id, `${channel} label points at its slider`);
    ids.add(input.id);
  }
  assert.equal(ids.size, 4);
  const second = panelOf();
  assert.ok(!ids.has(second.slider("P1").id), "two panels never share an id");
});

test("without levels the panel starts at the defaults; with levels it shows them", () => {
  const fresh = panelOf();
  assert.deepEqual(fresh.panel.get(), clampLevels(DEFAULT_LEVELS));
  assert.equal(fresh.slider("TR").value, String(DEFAULT_LEVELS.TR));
  assert.equal(fresh.valueText("TR").textContent, "+4 dB");

  const { panel, slider, valueText, mute } = panelOf(SOME_LEVELS);
  assert.deepEqual(panel.get(), SOME_LEVELS);
  assert.deepEqual(["P1", "P2", "TR", "NO"].map((channel) => slider(channel).value), ["0", "-1", "4.5", "-60"]);
  assert.deepEqual(["P1", "P2", "TR", "NO"].map((channel) => valueText(channel).textContent), ["0 dB", "−1 dB", "+4.5 dB", "Off"]);
  assert.equal(slider("P2").getAttribute("aria-valuetext"), "−1 dB", "screen readers hear dB too");
  assert.deepEqual(["P1", "P2", "TR", "NO"].map((channel) => mute(channel).getAttribute("aria-pressed")), ["false", "true", "false", "false"]);
});

test("moving a slider reports the full levels at once and updates its value", () => {
  const { slider, valueText, reported } = panelOf(SOME_LEVELS);
  const drums = slider("NO");
  drums.value = "6.5";
  drums.dispatch("input");

  assert.equal(reported.length, 1);
  assert.deepEqual(reported[0], { ...SOME_LEVELS, NO: 6.5 });
  assert.equal(valueText("NO").textContent, "+6.5 dB");
  assert.equal(drums.getAttribute("aria-valuetext"), "+6.5 dB");

  drums.value = "40";
  drums.dispatch("input");
  assert.equal(reported[1].NO, MAX_DB, "a value past the scale is clamped");
});

test("a mute button toggles its channel, says so with aria-pressed and reports the levels", () => {
  const { mute, reported } = panelOf();
  const bass = mute("TR");
  assert.equal(bass.type, "button");
  assert.match(bass.getAttribute("aria-label") ?? "", /Bass/);
  assert.match(bass.className, /\bbutton\b/);

  bass.dispatch("click");
  assert.equal(bass.getAttribute("aria-pressed"), "true");
  assert.equal(reported.at(-1)?.muted.TR, true);
  assert.equal(reported.at(-1)?.TR, DEFAULT_LEVELS.TR, "muting keeps the level for later");

  bass.dispatch("click");
  assert.equal(bass.getAttribute("aria-pressed"), "false");
  assert.equal(reported.at(-1)?.muted.TR, false);
});

test("Reset brings every level and mute back to the defaults and reports them", () => {
  const { panel, reset, slider, mute, reported } = panelOf(SOME_LEVELS);
  assert.equal(reset.type, "button");
  assert.match(reset.textContent, /Reset/);

  reset.dispatch("click");
  assert.deepEqual(reported.at(-1), clampLevels(DEFAULT_LEVELS));
  assert.deepEqual(panel.get(), clampLevels(DEFAULT_LEVELS));
  assert.equal(slider("NO").value, String(DEFAULT_LEVELS.NO));
  assert.equal(mute("P2").getAttribute("aria-pressed"), "false");
});

test("set shows new levels without reporting them, and get returns a copy", () => {
  const { panel, slider, valueText, mute, reported } = panelOf();
  panel.set(SOME_LEVELS);
  assert.equal(reported.length, 0, "set is not a change by the visitor");
  assert.equal(slider("TR").value, "4.5");
  assert.equal(valueText("NO").textContent, "Off");
  assert.equal(mute("P2").getAttribute("aria-pressed"), "true");

  const copy = panel.get();
  copy.P1 = -30;
  copy.muted.P1 = true;
  assert.deepEqual(panel.get(), SOME_LEVELS);
});

test("Reset goes back to the defaults it is given, and the title names the sound pack", () => {
  const container = new FakeDocument().createElement("div");
  /** @type {Levels[]} */
  const reported = [];
  const plainDefaults = { ...clampLevels(DEFAULT_LEVELS), NO: 5 };
  const panel = createMixerPanel(/** @type {any} */ (container), {
    levels: SOME_LEVELS,
    defaults: () => plainDefaults,
    onChange: (next) => reported.push(next),
  });
  one(container, hasClass("mixer-reset")).dispatch("click");
  assert.equal(reported.at(-1)?.NO, 5, "the pack's drums, not the chip's");
  assert.equal(panel.get().NO, 5);

  const title = one(container, hasClass("mixer-title"));
  panel.setTitle("Mix: Plain instruments");
  assert.equal(title.textContent, "Mix: Plain instruments");
});
