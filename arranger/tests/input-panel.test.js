// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { writeMidiFile } from "../src/core/midi-file.js";
import { catalogChoice, createInputPanel, isMidi, parseSections, sha256Hex, sharedTrackName, trackRangeBars } from "../src/ui/input-panel.js";

test("a file is MIDI when it starts with the chunk name MThd, whatever its name", () => {
  assert.equal(isMidi(new TextEncoder().encode("MThd\0\0\0\x06")), true);
  assert.equal(isMidi(new TextEncoder().encode("X:1\nT:Tune\nK:C\n")), false);
  assert.equal(isMidi(new Uint8Array([0x4d, 0x54])), false);
});

test("the section editor reads one bar and label per line", () => {
  assert.deepEqual(parseSections("0 A\n8 Chorus 2\n\n 16  A "), [[0, "A"], [8, "Chorus 2"], [16, "A"]]);
  assert.deepEqual(parseSections(""), []);
  assert.throws(() => parseSections("A at 0"), /must look like "8 Chorus"/);
});

test("the input fingerprint is the SHA-256 of the file bytes", async () => {
  assert.equal(
    await sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("the tempo summary of an excerpt weighs each tempo by how long it lasts", async () => {
  const { excerptTempos } = await import("../src/ui/input-panel.js");
  // Tempo changes as readMidiFile lists them: 120 BPM for 4 s, then 60 BPM until the end (8 s).
  const midi = {
    resolution: 480,
    tempoChanges: [
      { tick: 0, time: 0, bpm: 120 },
      { tick: 3840, time: 4, bpm: 60 },
    ],
    timeToTick: (/** @type {number} */ t) => (t <= 4 ? t * 960 : 3840 + (t - 4) * 480),
    tickToTime: (/** @type {number} */ k) => (k <= 3840 ? k / 960 : 4 + (k - 3840) / 480),
  };
  // Beats 0-12: 8 beats at 120 (4 s) and 4 beats at 60 (4 s), so each tempo lasts half the time.
  const summary = excerptTempos(/** @type {any} */ (midi), 0, 12);
  assert.deepEqual({ ...summary, median: Math.round(summary.median) }, { atStart: 120, min: 60, max: 120, median: 60 });
  assert.deepEqual(excerptTempos(/** @type {any} */ (midi), 8, 12), { atStart: 60, min: 60, max: 60, median: 60 });
});

test("a track name that every track repeats is found, so the table can leave it out", () => {
  assert.equal(sharedTrackName([{ name: "Amor I Love You" }, { name: "Amor I Love You" }]), "Amor I Love You");
  assert.equal(sharedTrackName([{ name: "Piano" }, { name: "Bass" }]), null);
  assert.equal(sharedTrackName([{ name: "Solo" }]), null, "one track repeats nothing");
  assert.equal(sharedTrackName([{ name: "" }, { name: "" }]), null);
});

test("the range bars of the tracks share one pitch axis, and drums and empty tracks have none", () => {
  const tracks = [
    { isDrum: false, noteCount: 3, lowest: 52, highest: 64 },
    { isDrum: false, noteCount: 5, lowest: 40, highest: 57 },
    { isDrum: true, noteCount: 9, lowest: 35, highest: 81 },
    { isDrum: false, noteCount: 0, lowest: Infinity, highest: -Infinity },
  ];
  assert.deepEqual(trackRangeBars(tracks), [
    { left: 12 / 24, width: 12 / 24 },
    { left: 0, width: 17 / 24 },
    null,
    null,
  ]);
  assert.deepEqual(trackRangeBars([{ isDrum: false, noteCount: 1, lowest: 60, highest: 60 }]), [{ left: 0, width: 0 }]);
});

test("the summary names the meter, or each meter in order when it changes", async () => {
  const { meterSummary } = await import("../src/ui/input-panel.js");
  const { parseMeter } = await import("../src/core/meter.js");
  const bars = (/** @type {string[]} */ ...texts) => texts.map((text) => ({ meter: parseMeter(text) }));

  assert.equal(meterSummary(bars("3/4", "3/4")), "3/4");
  assert.equal(meterSummary(bars("4/4", "2/4", "2/4", "3/4", "4/4")), "4/4, 2/4, 3/4");
});

// --- The panel in a fake document: the melody track, the bars and what stays loaded -------------
//
// Node has no DOM, so the panel is built in a small fake one. It knows only what the panel uses:
// elements parsed from the panel's own HTML (tag, attributes, classes), selectors of the forms
// `tag`, `.class`, `[attribute]`, `[attribute="value"]` and `:checked`, listeners and clicks.

/** An element of the fake document. Parsed children are kept flat under their parent. */
class FakeElement {
  /** @param {string} tagName @param {Record<string, string>} [attributes] */
  constructor(tagName, attributes = {}) {
    this.tagName = tagName.toLowerCase();
    /** @type {Map<string, string>} */
    this.attributes = new Map(Object.entries(attributes));
    /** @type {FakeElement[]} */
    this.children = [];
    /** @type {FakeElement | null} */
    this.parent = null;
    /** @type {Record<string, Array<(event: any) => void>>} */
    this.listeners = {};
    this.textContent = "";
    this.value = attributes.value ?? "";
    this.hidden = "hidden" in attributes;
    this.disabled = "disabled" in attributes;
    this.checked = "checked" in attributes;
    this.open = false;
    /** @type {Set<string>} */
    const classes = new Set((attributes.class ?? "").split(/\s+/).filter(Boolean));
    this.classList = {
      add: (/** @type {string} */ name) => classes.add(name),
      remove: (/** @type {string} */ name) => classes.delete(name),
      toggle: (/** @type {string} */ name, /** @type {boolean} */ force) => (force ?? !classes.has(name) ? classes.add(name) : classes.delete(name)),
      contains: (/** @type {string} */ name) => classes.has(name),
    };
  }

  get dataset() {
    return Object.fromEntries(
      [...this.attributes].filter(([name]) => name.startsWith("data-")).map(([name, value]) => [name.slice(5), value]),
    );
  }

  /** @param {string} html */
  set innerHTML(html) {
    this.children = [];
    this.insertAdjacentHTML("beforeend", html);
  }

  /** @param {string} _position @param {string} html */
  insertAdjacentHTML(_position, html) {
    for (const [, tag, attributeText] of html.matchAll(/<([a-z][a-z0-9]*)((?:[^>"]|"[^"]*")*)>/g)) {
      /** @type {Record<string, string>} */
      const attributes = {};
      for (const [, name, value] of attributeText.matchAll(/([a-z][\w:-]*)(?:="([^"]*)")?/g)) attributes[name] = value ?? "";
      this.append(new FakeElement(tag, attributes));
    }
  }

  /** @param {...FakeElement} nodes */
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  /** @param {string} name @param {string} value */
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  /** @param {string} type @param {(event: any) => void} listener */
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }

  /** @param {string} type @param {Record<string, unknown>} [fields] */
  fire(type, fields = {}) {
    for (const listener of this.listeners[type] ?? []) listener({ type, target: this, preventDefault() {}, ...fields });
  }

  /** @param {FakeElement} node */
  contains(node) {
    return node === this || this.children.some((child) => child.contains(node));
  }

  /** A click; on a radio button it also checks it, unchecks the others of its group and fires change. */
  click() {
    if (this.tagName === "input" && this.attributes.get("type") === "radio" && !this.checked) {
      let root = /** @type {FakeElement} */ (this);
      while (root.parent) root = root.parent;
      for (const other of root.all()) {
        if (other.attributes.get("name") === this.attributes.get("name")) other.checked = false;
      }
      this.checked = true;
      this.fire("change");
    }
    this.fire("click");
  }

  /** @returns {FakeElement[]} every descendant, in document order */
  all() {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }

  /** @param {string} selector @returns {boolean} */
  matches(selector) {
    const [, tag = "", rest = ""] = /** @type {RegExpMatchArray} */ (selector.match(/^([a-z]*)(.*)$/));
    if (tag && tag !== this.tagName) return false;
    for (const [, kind, name, value] of rest.matchAll(/\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|(:checked)/g).map((m) => [m[0], m[1] ? "class" : m[2] ? "attribute" : "checked", m[1] ?? m[2], m[3]])) {
      if (kind === "class" && !this.classList.contains(name)) return false;
      if (kind === "attribute" && (!this.attributes.has(name) || (value !== undefined && this.attributes.get(name) !== value))) return false;
      if (kind === "checked" && !this.checked) return false;
    }
    return true;
  }

  /** @param {string} selector */
  querySelector(selector) {
    return this.all().find((node) => node.matches(selector)) ?? null;
  }

  /** @param {string} selector */
  querySelectorAll(selector) {
    return this.all().filter((node) => node.matches(selector));
  }
}

/**
 * Run `body` with a fake `document`, and give it the panel's four targets, children of one root.
 *
 * @param {(targets: {root: FakeElement, file: FakeElement, examples: FakeElement, details: FakeElement}) => Promise<void>} body
 */
async function inFakeDocument(body) {
  const real = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: (/** @type {string} */ tag) => new FakeElement(tag), head: new FakeElement("head") },
  });
  try {
    const root = new FakeElement("section");
    const [file, examples, details] = ["file", "examples", "details"].map(() => new FakeElement("div"));
    root.append(file, examples, details);
    await body({ root, file, examples, details });
  } finally {
    if (real) Object.defineProperty(globalThis, "document", real);
    else delete (/** @type {any} */ (globalThis)).document;
  }
}

/**
 * A MIDI song of `bars` 4/4 bars at 120 BPM with the given pitched tracks: a track plays one
 * note every half second, stepping up from its pitch, so each track has a melody of its own.
 *
 * @param {Array<{name: string, program: number, pitch: number}>} tracks
 * @param {number} [bars]
 */
function songBytes(tracks, bars = 8) {
  return writeMidiFile({
    tempoBpm: 120,
    tracks: tracks.map((track, index) => ({
      name: track.name,
      channel: index,
      program: track.program,
      notes: Array.from({ length: bars * 4 }, (_, step) => ({
        start: step * 0.5,
        end: step * 0.5 + 0.4,
        pitch: track.pitch + (step % 4),
        velocity: 100,
      })),
    })),
  });
}

/** Voice and flute play two different melodies, over a bass line. */
const TWO_MELODIES = songBytes([
  { name: "Voice", program: 73, pitch: 72 },
  { name: "Flute", program: 73, pitch: 79 },
  { name: "Bass", program: 33, pitch: 40 },
]);

/**
 * A panel on a fake document that records every lead sheet it hands over.
 *
 * @param {Awaited<Parameters<Parameters<typeof inFakeDocument>[0]>[0]>} targets
 */
function openPanel(targets) {
  /** @type {import("../src/ui/input-panel.js").LoadedInput[]} */
  const loads = [];
  let unreadable = 0;
  const panel = createInputPanel(/** @type {any} */ (targets), {
    examples: [],
    readOptions: () => ({ phraseLength: 4, roleMap: {}, tempoOverride: null }),
    onLoaded: (loaded) => loads.push(loaded),
    onUnreadable: () => (unreadable += 1),
  });
  const radio = (/** @type {number} */ track) => /** @type {FakeElement} */ (targets.root.querySelector(`input[name="melody-track"][value="${track}"]`));
  const field = (/** @type {string} */ name) => /** @type {FakeElement} */ (targets.root.querySelector(`[data-${name}]`));
  return {
    panel,
    loads,
    radio,
    field,
    get unreadable() {
      return unreadable;
    },
    chosen: () => Number(targets.root.querySelector('input[name="melody-track"]:checked')?.value),
    firstPitch: () => /** @type {number} */ (loads.at(-1)?.leadSheet.bars[0].melody[0].pitch),
    /** @param {Uint8Array} bytes @param {string} [name] */
    open: (bytes, name = "song.mid") => panel.readFile(/** @type {any} */ (new File([bytes], name))),
  };
}

test("choosing another melody track reads the song again with that track, and choosing back returns", async () => {
  await inFakeDocument(async (targets) => {
    const page = openPanel(targets);
    await page.open(TWO_MELODIES);
    assert.equal(page.loads.at(-1)?.midi.melody_track, page.chosen(), "the likeliest track is chosen at first");

    page.radio(1).click();
    assert.equal(page.loads.at(-1)?.midi.melody_track, 1);
    assert.equal(page.firstPitch(), 79, "the lead sheet's melody is the flute's");

    page.radio(0).click();
    assert.equal(page.loads.at(-1)?.midi.melody_track, 0);
    assert.equal(page.firstPitch(), 72, "and back to the voice's");
  });
});

test("a second MIDI file replaces the first, with its own tracks and its own likeliest melody", async () => {
  await inFakeDocument(async (targets) => {
    const page = openPanel(targets);
    await page.open(TWO_MELODIES, "first.mid");
    page.radio(1).click();

    await page.open(songBytes([{ name: "Bass", program: 33, pitch: 40 }, { name: "Lead", program: 80, pitch: 76 }], 4), "second.mid");
    const loaded = /** @type {any} */ (page.loads.at(-1));
    assert.equal(loaded.input.name, "second.mid");
    assert.equal(targets.root.querySelectorAll('input[name="melody-track"]').length, 2, "the table lists the second file's tracks");
    assert.equal(loaded.midi.melody_track, 1, "the lead, not the choice made on the first file");
    assert.equal(page.chosen(), 1);
    assert.equal(loaded.leadSheet.bars.length, 4);
  });
});

test("changing the bars reads the song again at once, with the track already chosen", async () => {
  await inFakeDocument(async (targets) => {
    const page = openPanel(targets);
    await page.open(TWO_MELODIES);
    page.radio(1).click();

    page.field("end").value = "4";
    page.field("end").fire("change");
    const loaded = /** @type {any} */ (page.loads.at(-1));
    assert.deepEqual(loaded.midi.bars, [0, 4]);
    assert.equal(loaded.leadSheet.bars.length, 4, "Arrange would not need a press on Read again");
    assert.equal(loaded.midi.melody_track, 1, "the chosen track stays");
    assert.equal(page.chosen(), 1);
  });
});

test("changing where the parts start reads the song again at once", async () => {
  await inFakeDocument(async (targets) => {
    const page = openPanel(targets);
    await page.open(TWO_MELODIES);

    page.field("sections").value = "0 Verse\n4 Chorus";
    page.field("sections").fire("change");
    const bars = /** @type {any} */ (page.loads.at(-1)).leadSheet.bars;
    assert.equal(bars[3].label, "Verse");
    assert.equal(bars[4].label, "Chorus");
  });
});

test("when the excerpt cannot be read, no earlier reading stays loaded to be arranged by mistake", async () => {
  await inFakeDocument(async (targets) => {
    const page = openPanel(targets);
    await page.open(TWO_MELODIES);
    page.radio(1).click();
    const loadsBefore = page.loads.length;

    page.field("end").value = "0"; // an excerpt that ends before it starts
    page.field("end").fire("change");
    assert.equal(page.panel.current(), null, "the panel holds nothing to arrange");
    assert.equal(page.unreadable, 1, "and tells the page, so Arrange is disabled");
    assert.equal(page.loads.length, loadsBefore);
    assert.match(targets.root.querySelector("[data-status]")?.textContent ?? "", /bar/i);

    page.field("end").value = "6";
    page.field("end").fire("change");
    assert.deepEqual(/** @type {any} */ (page.panel.current()).midi.bars, [0, 6]);
    assert.equal(/** @type {any} */ (page.panel.current()).midi.melody_track, 1);
  });
});

test("a file the page claims as a download comes with its catalog record and the record's own limits", async () => {
  await inFakeDocument(async (targets) => {
    /** @type {import("../src/ui/input-panel.js").LoadedInput[]} */
    const loads = [];
    const record = { id: "x", source: "mpb", t: "Song", u: "https://example.org/song", facts: { overrides: { max_generations: 4000 } } };
    /** @type {string[]} */
    const asked = [];
    const panel = createInputPanel(/** @type {any} */ (targets), {
      examples: [],
      readOptions: () => ({ phraseLength: 4, roleMap: {}, tempoOverride: null }),
      onLoaded: (loaded) => loads.push(loaded),
      onFileDropped: (name) => {
        asked.push(name);
        return name === "song.mid" ? record : null;
      },
    });
    await panel.readFile(/** @type {any} */ (new File([TWO_MELODIES], "song.mid")));
    assert.deepEqual(asked, ["song.mid"]);
    assert.equal(loads.at(-1)?.input.catalogEntry, record);
    assert.deepEqual(loads.at(-1)?.overrides, { max_generations: 4000 }, "the record's stopping limits apply, as when it opens from the shelf");
    const summaryClasses = () => /** @type {any} */ (targets.root.querySelector("[data-summary]")).classList;
    assert.ok(summaryClasses().contains("from-catalog"), "the summary leaves out what the shelf's panel already says");

    await panel.readFile(/** @type {any} */ (new File([TWO_MELODIES], "other.mid")));
    assert.equal(loads.at(-1)?.input.catalogEntry, null, "an unclaimed file stays the visitor's own");
    assert.deepEqual(loads.at(-1)?.overrides, {});
    assert.ok(!summaryClasses().contains("from-catalog"), "a visitor's own file has no panel above it: the summary says it all");
  });
});

test("a catalog record's analysis picks the melody track, the bars and the parts, when they fit the file", () => {
  const tracks = [
    { index: 0, isDrum: false },
    { index: 1, isDrum: false },
    { index: 2, isDrum: true },
  ];
  const facts = { melody_track: 1, bars: /** @type {[number, number]} */ ([2, 66]), sections: [[0, "A"], [32, "B"]] };
  assert.deepEqual(catalogChoice(facts, tracks, 80), { melodyTrack: 1, bars: [2, 66], sections: "0 A\n32 B" });
  assert.equal(catalogChoice(undefined, tracks, 80), null, "a visitor's own file has no analysis");
  assert.equal(catalogChoice({ ...facts, melody_track: 2 }, tracks, 80), null, "a drum track never carries the melody");
  assert.equal(catalogChoice({ ...facts, melody_track: 7 }, tracks, 80), null, "a track the file does not have");
  assert.equal(catalogChoice(facts, tracks, 40), null, "bars past the file's end: another file than the one analysed");
  assert.deepEqual(catalogChoice({ melody_track: 0 }, tracks, 80), { melodyTrack: 0, bars: null, sections: null });
});
