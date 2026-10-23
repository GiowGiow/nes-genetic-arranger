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
import { METER_CEILING_DB, METER_FLOOR_DB, NEEDLE_RANGE_DEGREES, createMixerPanel, formatLevel, meterPosition, needleAngle, vuBallistics } from "../src/ui/mixer-panel.js";
import { createVolumeSlider } from "../src/ui/volume-slider.js";

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
    if (name === "class") this.className = String(value); // an SVG element has no settable className
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
  /** @param {string} _namespace @param {string} tagName */
  createElementNS(_namespace, tagName) {
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

// --- Master volume ------------------------------------------------------------------------------

/** A panel with a volume callback; the volume it reported is in `volumes`. */
function volumePanel(volume = 80) {
  const container = new FakeDocument().createElement("div");
  /** @type {number[]} */
  const volumes = [];
  const panel = createMixerPanel(/** @type {any} */ (container), {
    volume,
    onChange: () => {},
    onVolume: (percent) => volumes.push(percent),
  });
  const row = one(container, hasClass("mixer-volume"));
  const slider = one(row, (element) => element.tagName === "INPUT");
  const value = one(row, hasClass("mixer-value"));
  return { container, panel, volumes, row, slider, value };
}

test("the first row of the mixer is the master Volume, before the four channels, with no channel code", () => {
  const { container, row, slider } = volumePanel();
  const root = container.children[0];
  const rowsInOrder = root.children.filter((child) => hasClass("mixer-row")(child) || hasClass("mixer-volume")(child));
  assert.equal(rowsInOrder[0], row, "Volume comes first");
  assert.equal(row.getAttribute("data-channel"), null, "it is not one of the arrangement's channels");
  const label = one(row, (element) => element.tagName === "LABEL");
  assert.match(label.textContent, /^Volume$/);
  assert.equal(label.htmlFor, slider.id);
  assert.equal(slider.type, "range");
  assert.deepEqual([slider.min, slider.max, slider.step], ["0", "100", "1"]);
  assert.equal(root.getAttribute("aria-label"), "Channel levels");
});

test("the Volume slider shows its percentage, reports each move, and the title names the sound pack only", () => {
  const { slider, value, volumes, panel } = volumePanel(80);
  assert.equal(slider.value, "80");
  assert.equal(value.textContent, "80%");
  assert.equal(slider.getAttribute("aria-valuetext"), "80%");

  slider.value = "35";
  slider.dispatch("input");
  assert.deepEqual(volumes, [35]);
  assert.equal(value.textContent, "35%");
  assert.equal(panel.getVolume(), 35);

  slider.value = "400";
  slider.dispatch("input");
  assert.equal(volumes.at(-1), 100, "past the slider is clamped");
});

test("setVolume shows a volume without reporting it, and Reset leaves the volume alone", () => {
  const { container, panel, slider, value, volumes } = volumePanel(80);
  panel.setVolume(20);
  assert.equal(volumes.length, 0, "not a change by the visitor");
  assert.equal(slider.value, "20");
  assert.equal(value.textContent, "20%");
  one(container, hasClass("mixer-reset")).dispatch("click");
  assert.equal(panel.getVolume(), 20, "Reset is for the channel levels of a sound pack, not the speakers");
  assert.equal(volumes.length, 0);
});

test("without a volume option the panel starts at the default 80 percent", () => {
  const { panel } = panelOf();
  assert.equal(panel.getVolume(), 80);
});

test("the compact volume slider beside Play is the same control: it reports and shows in step with the mixer's", () => {
  const doc = new FakeDocument();
  /** @type {number[]} */
  const heard = [];
  const compact = createVolumeSlider(/** @type {any} */ (doc), { id: "volume-compact", volume: 80, compact: true, onInput: (percent) => heard.push(percent) });
  const input = one(compact.root, (element) => element.tagName === "INPUT");
  assert.match(compact.root.className, /\bvolume-compact\b/);
  assert.equal(input.getAttribute("aria-label"), "Volume", "the short visible label does not replace the name");
  input.value = "55";
  input.dispatch("input");
  assert.deepEqual(heard, [55]);
  compact.set(10);
  assert.equal(input.value, "10");
  assert.equal(heard.length, 1, "set is not a change by the visitor");
});

// --- VU meters ----------------------------------------------------------------------------------
//
// Each channel has a small analog needle meter that moves while music plays. The panel does not
// listen to the audio: it is given a function that returns the current level of each channel
// (the page gets it from the player), and it reads that function once per animation frame, only
// while metering is on.

test("a level maps to the needle's range by decibels: the floor rests, the ceiling is full scale, and louder stays there", () => {
  assert.equal(meterPosition(0), 0, "silence rests");
  assert.equal(meterPosition(10 ** (METER_FLOOR_DB / 20)), 0);
  assert.equal(meterPosition(10 ** (METER_CEILING_DB / 20)), 1);
  assert.equal(meterPosition(1), 1, "a full-scale wave pins the needle");
  const middle = (METER_FLOOR_DB + METER_CEILING_DB) / 2;
  assert.ok(Math.abs(meterPosition(10 ** (middle / 20)) - 0.5) < 1e-9, "halfway in dB is halfway on the dial");
  assert.ok(meterPosition(0.1) < meterPosition(0.2), "a louder channel moves the needle further");
});

test("the needle sweeps from the left stop to the right stop", () => {
  assert.equal(needleAngle(0), -NEEDLE_RANGE_DEGREES / 2);
  assert.equal(needleAngle(1), NEEDLE_RANGE_DEGREES / 2);
  assert.equal(needleAngle(0.5), 0);
  assert.equal(needleAngle(7), NEEDLE_RANGE_DEGREES / 2, "past the stop is held at the stop");
});

test("a needle rises faster than it falls, like a VU meter's, and never overshoots", () => {
  const rise = vuBallistics(0, 1, 0.05) - 0;
  const fall = 1 - vuBallistics(1, 0, 0.05);
  assert.ok(rise > fall * 3, `rises ${rise.toFixed(2)} in 50 ms, falls ${fall.toFixed(2)}`);
  assert.equal(vuBallistics(0.4, 0.4, 0.05), 0.4, "at its target it stays");
  assert.ok(vuBallistics(0, 1, 10) <= 1);
  assert.ok(vuBallistics(1, 0, 10) >= 0);
  assert.equal(vuBallistics(0.3, 0.9, 0), 0.3, "no time, no movement");
});

/**
 * A panel whose meters read levels from a variable and whose animation frames the test runs.
 * @param {{reducedMotion?: boolean}} [options]
 */
function meteredPanel({ reducedMotion = false } = {}) {
  const container = new FakeDocument().createElement("div");
  /** @type {Partial<Record<"P1" | "P2" | "TR" | "NO", number>>} */
  const heard = {};
  let reads = 0;
  /** @type {Map<number, (now: number) => void>} */
  const frames = new Map();
  let nextFrame = 1;
  const panel = createMixerPanel(/** @type {any} */ (container), {
    onChange: () => {},
    readMeters: () => {
      reads += 1;
      return heard;
    },
    requestFrame: (run) => {
      const id = nextFrame++;
      frames.set(id, run);
      return id;
    },
    cancelFrame: (id) => void frames.delete(id),
    reducedMotion,
  });
  /** Run the pending frame at time `now` (ms), as the browser would. @param {number} now */
  const frame = (now) => {
    const pending = [...frames];
    frames.clear();
    for (const [, run] of pending) run(now);
  };
  const needle = (/** @type {string} */ channel) => {
    const row = all(container, (element) => element.getAttribute("data-channel") === channel)[0];
    return one(row, hasClass("vu-needle"));
  };
  return { container, panel, heard, frame, frames, needle, reads: () => reads };
}

test("every channel row has an analog meter with a dial and a needle, hidden from screen readers", () => {
  const { container, needle } = meteredPanel();
  for (const channel of ["P1", "P2", "TR", "NO"]) {
    const row = all(container, (element) => element.getAttribute("data-channel") === channel)[0];
    const meter = one(row, hasClass("mixer-vu"));
    assert.equal(meter.getAttribute("aria-hidden"), "true", "the sliders already speak; the needle is for the eye");
    one(meter, hasClass("vu-dial"));
    assert.equal(needle(channel).getAttribute("transform"), `rotate(${-NEEDLE_RANGE_DEGREES / 2} 24 29)`, "it rests on the left stop");
  }
  const volume = one(container, hasClass("mixer-volume"));
  assert.equal(all(volume, hasClass("mixer-vu")).length, 0, "the master volume has no meter of its own");
});

test("meters are idle until metering starts: no animation frame is asked for", () => {
  const { frames, reads } = meteredPanel();

  assert.equal(frames.size, 0);
  assert.equal(reads(), 0);
});

test("while metering, each frame reads the levels and swings the needles toward them", () => {
  const { panel, heard, frame, needle } = meteredPanel();
  heard.P1 = 10 ** (METER_CEILING_DB / 20); // full scale
  heard.TR = 10 ** (((METER_FLOOR_DB + METER_CEILING_DB) / 2) / 20); // half way

  panel.setMetering(true);
  frame(1000);
  for (let now = 1033; now <= 1700; now += 33) frame(now);

  const angle = (/** @type {string} */ channel) => Number(/rotate\((-?[\d.]+)/.exec(needle(channel).getAttribute("transform") ?? "")?.[1]);
  assert.ok(Math.abs(angle("P1") - NEEDLE_RANGE_DEGREES / 2) < 1, `P1 reached the right stop (${angle("P1")})`);
  assert.ok(Math.abs(angle("TR")) < 1, `TR settled at the middle (${angle("TR")})`);
  assert.equal(angle("NO"), -NEEDLE_RANGE_DEGREES / 2, "a silent channel stays at rest");
});

test("frames closer than 33 ms are skipped, so the meters cost little on a phone", () => {
  const { panel, frame, reads } = meteredPanel();
  panel.setMetering(true);

  frame(1000);
  frame(1010);
  frame(1020);
  frame(1040);

  assert.equal(reads(), 2, "1000 and 1040 only");
});

test("when metering stops the needles fall back to rest and then the frames stop", () => {
  const { panel, heard, frame, frames, needle } = meteredPanel();
  heard.P2 = 1;
  panel.setMetering(true);
  for (let now = 1000; now < 1500; now += 33) frame(now);
  assert.ok(!needle("P2").getAttribute("transform")?.includes(`${-NEEDLE_RANGE_DEGREES / 2} `), "raised");

  panel.setMetering(false);
  let now = 1500;
  for (let step = 0; step < 200 && frames.size > 0; step++, now += 33) frame(now);

  assert.equal(frames.size, 0, "no frame is left running");
  assert.equal(needle("P2").getAttribute("transform"), `rotate(${-NEEDLE_RANGE_DEGREES / 2} 24 29)`);
});

test("asking for metering twice does not start two loops", () => {
  const { panel, frames } = meteredPanel();

  panel.setMetering(true);
  panel.setMetering(true);

  assert.equal(frames.size, 1);
});

test("a visitor who asked for less motion gets still needles", () => {
  const { panel, frames, needle } = meteredPanel({ reducedMotion: true });

  panel.setMetering(true);

  assert.equal(frames.size, 0);
  assert.equal(needle("P1").getAttribute("transform"), `rotate(${-NEEDLE_RANGE_DEGREES / 2} 24 29)`);
});

test("a panel built without a level source ignores setMetering", () => {
  const { panel } = panelOf();

  assert.doesNotThrow(() => panel.setMetering(true));
  assert.doesNotThrow(() => panel.setMetering(false));
});
