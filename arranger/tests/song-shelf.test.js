// @ts-check
// Tests for ui/song-shelf.js: the catalog as pages of vinyl records, with a side panel, a pager
// and a DOM listbox that keyboards and screen readers use (spec 005, story 3, FR-009 to FR-014a,
// research R6 and R7).
//
// Node has no DOM, so a small fake document below builds the elements the shelf creates: tags,
// attributes, classes, text, listeners and canvases. The 3D scene is replaced by a fake that
// records its calls, since Node has no WebGL either.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PLAYLIST_KEY,
  createSongShelf,
  factSummary,
  keyLabel,
  stepSelection,
  swipeGesture,
  webglAvailable,
  wheelDelta,
} from "../src/ui/song-shelf.js";

// --- A fake document ---------------------------------------------------------------------------

class FakeEvent {
  /** @param {string} type @param {Record<string, unknown>} [fields] */
  constructor(type, fields = {}) {
    this.type = type;
    this.defaultPrevented = false;
    this.propagationStopped = false;
    Object.assign(this, fields);
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }
}

class FakeElement {
  /** @param {FakeDocument} ownerDocument @param {string} tagName */
  constructor(ownerDocument, tagName) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
    /** @type {FakeElement[]} */
    this.children = [];
    /** @type {FakeElement | null} */
    this.parentNode = null;
    /** @type {Map<string, string>} */
    this.attributes = new Map();
    /** @type {Map<string, Array<(event: any) => void>>} */
    this.listeners = new Map();
    this.ownText = "";
    this.hidden = false;
    this.disabled = false;
    this.clientWidth = 0;
    this.clientHeight = 0;
    /** @type {Record<string, string>} */
    this.styleValues = {};
    this.style = { setProperty: (/** @type {string} */ name, /** @type {string} */ value) => (this.styleValues[name] = value) };
    const classes = new Set();
    this.classList = {
      add: (/** @type {string[]} */ ...names) => names.forEach((name) => classes.add(name)),
      remove: (/** @type {string[]} */ ...names) => names.forEach((name) => classes.delete(name)),
      toggle: (/** @type {string} */ name, /** @type {boolean | undefined} */ force) => {
        const on = force ?? !classes.has(name);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains: (/** @type {string} */ name) => classes.has(name),
      values: () => [...classes],
    };
    /** @type {Array<{fillStyle: string, rect: number[]}>} */
    this.painted = [];
  }

  get id() {
    return this.attributes.get("id") ?? "";
  }

  set id(value) {
    this.attributes.set("id", value);
  }

  /** @param {string} name @param {unknown} value */
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  /** @param {string} name */
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  /** @param {string} name */
  removeAttribute(name) {
    this.attributes.delete(name);
  }

  /** @param {FakeElement[]} nodes */
  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }

  /** @param {FakeElement[]} nodes */
  replaceChildren(...nodes) {
    this.children = [];
    this.ownText = "";
    this.append(...nodes);
  }

  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this.children = [];
    this.ownText = String(value);
  }

  /** @param {string} type @param {(event: any) => void} listener */
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** @param {string} type @param {(event: any) => void} listener */
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((known) => known !== listener));
  }

  /** @param {FakeEvent} event */
  dispatchEvent(event) {
    Object.assign(event, { target: event.target ?? this });
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return !event.defaultPrevented;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  /** @param {string} kind */
  getContext(kind) {
    if (this.tagName !== "CANVAS" || kind !== "2d") return null;
    const element = this;
    return {
      fillStyle: "",
      /** @param {number[]} rect */
      fillRect(...rect) {
        element.painted.push({ fillStyle: this.fillStyle, rect });
      },
      clearRect() {},
      imageSmoothingEnabled: true,
    };
  }
}

class FakeDocument {
  constructor() {
    /** @type {FakeElement | null} */
    this.activeElement = null;
  }

  /** @param {string} tagName */
  createElement(tagName) {
    return new FakeElement(this, tagName);
  }
}

/**
 * Every element under `root`, root included, in document order.
 * @param {FakeElement} root
 * @returns {FakeElement[]}
 */
function all(root) {
  return [root, ...root.children.flatMap(all)];
}

/** @param {FakeElement} root @param {string} name */
const byClass = (root, name) => all(root).filter((element) => element.classList.contains(name));
/** @param {FakeElement} root @param {string} role */
const byRole = (root, role) => all(root).filter((element) => element.getAttribute("role") === role);
/** @param {FakeElement} root @param {string} text */
const button = (root, text) => {
  const found = all(root).find((element) => element.tagName === "BUTTON" && element.textContent === text);
  assert.ok(found, `no button "${text}"`);
  return found;
};

/** @param {FakeElement} element @param {string} key */
function press(element, key) {
  const event = new FakeEvent("keydown", { key });
  element.dispatchEvent(event);
  return event;
}

/** @param {FakeElement} element */
const click = (element) => element.dispatchEvent(new FakeEvent("click"));

// --- Sample entries (invented) -----------------------------------------------------------------

/**
 * @param {number} i
 * @param {Record<string, unknown>} [extra]
 */
function song(i, extra = {}) {
  return {
    id: `song-${i}`,
    source: i < 3 ? "examples" : "nottingham",
    t: i === 3 ? "ÁGUA DE TESTE" : `Song ${String(i).padStart(2, "0")}`,
    c: `Composer ${i}`,
    p: i === 3 ? "Banda Inventada" : "",
    u: `https://www.beakauffmann.com/mpb_s/song-${i}.html`,
    license: "all-rights-reserved",
    seed: 1000 + i,
    route: { abc: `data/catalog/abc/song-${i}.abc`, tune: 0 },
    pop: 100 - i,
    facts: { key: i % 2 ? "e- minor" : "G major", tempo_bpm: 120.4 + i, meter: "4/4", n_bars: 32 },
    ...extra,
  };
}

const twenty = () => Array.from({ length: 20 }, (_, i) => song(i));

/**
 * A shelf in a fake root, without WebGL unless a scene is given.
 * @param {Record<string, any>} [options]
 * @param {number} [width] the root's width in CSS pixels
 */
function mount(options = {}, width = 0) {
  const document = new FakeDocument();
  const root = document.createElement("div");
  root.clientWidth = width;
  /** @type {any[]} */
  const arranged = [];
  /** @type {any[]} */
  const previewed = [];
  const shelf = createSongShelf(/** @type {any} */ (root), {
    entries: twenty(),
    onArrange: (/** @type {any} */ entry) => arranged.push(entry),
    onPreview: (/** @type {any} */ entry) => previewed.push(entry),
    webgl: false,
    reducedMotion: false,
    storage: null,
    ...options,
  });
  const list = byRole(root, "listbox")[0];
  return { document, root, shelf, list, arranged, previewed };
}

/** @param {FakeElement} root */
const optionsOf = (root) => byRole(root, "option");
/** @param {FakeElement} root the playlist tiles (or the album tiles) now in the chooser */
const tiles = (root) => byClass(root, "shelf-tile");
/** @param {FakeElement} root @param {string} name */
const tile = (root, name) => {
  const found = tiles(root).find((element) => byClass(element, "shelf-tile-name")[0].textContent === name);
  assert.ok(found, `no tile "${name}" among ${tiles(root).map((element) => byClass(element, "shelf-tile-name")[0].textContent)}`);
  return found;
};
/** @param {FakeElement} root */
const tileNames = (root) => tiles(root).map((element) => byClass(element, "shelf-tile-name")[0].textContent);
/** @param {FakeElement} root */
const pressedTiles = (root) => tiles(root).filter((element) => element.getAttribute("aria-pressed") === "true");
/** @param {FakeElement} root the titles in the side list, in order */
const rowTitles = (root) => byClass(root, "shelf-song").map((row) => byClass(row, "shelf-song-title")[0].textContent);
/** @param {FakeElement} root */
const viewText = (root) => byClass(root, "shelf-view")[0].textContent;

/** A storage that keeps strings in a map, like `localStorage`. @param {Record<string, string>} [initial] */
function fakeStorage(initial = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (/** @type {string} */ key) => items.get(key) ?? null,
    setItem: (/** @type {string} */ key, /** @type {string} */ value) => void items.set(key, value),
  };
}
/** @param {FakeElement} root */
const panelText = (root) => byClass(root, "shelf-info")[0].textContent;
/** @param {FakeElement} root */
const pagerText = (root) => byClass(root, "shelf-page")[0].textContent;

/** A fake scene module that records what the shelf asks of it. */
function fakeScene() {
  /** @type {Array<[string, ...any[]]>} */
  const calls = [];
  /** @type {((index: number) => void) | null} */
  let pick = null;
  const module = {
    createShelfScene(/** @type {any} */ host, /** @type {any} */ options) {
      calls.push(["create", host, options]);
      return {
        setPage: (/** @type {any[]} */ entries, /** @type {number} */ index) => calls.push(["setPage", entries.map((e) => e.id), index]),
        select: (/** @type {number} */ index) => calls.push(["select", index]),
        onPick: (/** @type {(index: number) => void} */ callback) => (pick = callback),
        resize: () => calls.push(["resize"]),
        dispose: () => calls.push(["dispose"]),
      };
    },
  };
  return { calls, module, pick: (/** @type {number} */ index) => pick?.(index) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// --- Pure helpers ------------------------------------------------------------------------------

test("arrow keys move one record or one row, and cross the edges of a page", () => {
  const wide = { total: 40, columns: 5, perPage: 15 };
  assert.equal(stepSelection(3, "ArrowRight", wide), 4);
  assert.equal(stepSelection(14, "ArrowRight", wide), 15, "the last record of a page leads to the next page");
  assert.equal(stepSelection(15, "ArrowLeft", wide), 14, "and back");
  assert.equal(stepSelection(12, "ArrowDown", wide), 17, "the bottom row leads to the next page's top row");
  assert.equal(stepSelection(17, "ArrowUp", wide), 12);
  assert.equal(stepSelection(0, "ArrowLeft", wide), null, "nothing before the first song");
  assert.equal(stepSelection(39, "ArrowRight", wide), null, "nothing after the last song");
  assert.equal(stepSelection(2, "ArrowUp", wide), null);
});

test("down from a row with no full row below goes to the last song, or stays on the last row", () => {
  assert.equal(stepSelection(12, "ArrowDown", { total: 16, columns: 5, perPage: 15 }), 15);
  assert.equal(stepSelection(15, "ArrowDown", { total: 18, columns: 5, perPage: 15 }), null);
});

test("Home and End go to the ends of the page; PageUp and PageDown keep the place on the page", () => {
  const wide = { total: 40, columns: 5, perPage: 15 };
  assert.equal(stepSelection(20, "Home", wide), 15);
  assert.equal(stepSelection(20, "End", wide), 29);
  assert.equal(stepSelection(37, "End", wide), 39, "the last page may be short");
  assert.equal(stepSelection(4, "PageDown", wide), 19);
  assert.equal(stepSelection(19, "PageUp", wide), 4);
  assert.equal(stepSelection(28, "PageDown", wide), 39, "the last page holds fewer songs");
  assert.equal(stepSelection(33, "PageDown", wide), null, "no page after the last");
  assert.equal(stepSelection(4, "PageUp", wide), null);
  assert.equal(stepSelection(4, "x", wide), null);
  assert.equal(stepSelection(0, "ArrowRight", { total: 0, columns: 5, perPage: 15 }), null);
});

test("keys read as written, and facts as a short row of values, leaving out what is unknown", () => {
  assert.equal(keyLabel("e- minor"), "Eb minor");
  assert.equal(keyLabel("f# minor"), "F# minor");
  assert.equal(keyLabel("C major"), "C major");
  assert.equal(keyLabel(""), "—");
  assert.deepEqual(factSummary(song(1)), ["Eb minor", "121 BPM", "4/4", "32 bars"]);
  assert.deepEqual(factSummary({ id: "x", t: "X" }), [], "no facts, no row");
  assert.deepEqual(factSummary({ id: "x", t: "X", facts: { key: "G major", n_bars: 1 } }), ["G major", "1 bar"]);
});

test("WebGL 2 (which three.js needs) is used when the browser has it, unless the address asks for ?no-webgl", () => {
  const WebGL2RenderingContext = function () {};
  assert.equal(webglAvailable({ WebGL2RenderingContext, location: { search: "" } }), true);
  assert.equal(webglAvailable({ WebGL2RenderingContext, location: { search: "?no-webgl" } }), false);
  assert.equal(webglAvailable({ WebGL2RenderingContext, location: { search: "?a=1&no-webgl=1" } }), false);
  assert.equal(webglAvailable({ WebGLRenderingContext: function () {}, location: { search: "" } }), false, "WebGL 1 only");
});

// --- The listbox and the panel ----------------------------------------------------------------

test("the current page is a listbox of 15 songs, the first one selected", () => {
  const { root, list } = mount();
  assert.equal(list.getAttribute("tabindex"), "0");
  assert.match(String(list.getAttribute("aria-label")), /^Songs, page 1 of 2$/);
  const options = optionsOf(root);
  assert.equal(options.length, 15);
  assert.equal(options[0].getAttribute("aria-selected"), "true");
  assert.equal(options[1].getAttribute("aria-selected"), "false");
  assert.equal(list.getAttribute("aria-activedescendant"), options[0].id);
  assert.equal(new Set(options.map((option) => option.id)).size, 15, "unique ids");
  assert.equal(options[4].getAttribute("aria-posinset"), "5");
  assert.equal(options[4].getAttribute("aria-setsize"), "20");
  assert.match(options[3].textContent, /Água de Teste/);
  assert.equal(pagerText(root), "Page 1 of 2");
});

test("a list beside the records names every song of the catalog, not only the page, and marks the selected one", () => {
  const { root, shelf, list } = mount();
  const songs = byClass(root, "shelf-songs")[0];
  assert.equal(songs.getAttribute("aria-hidden"), "true", "the listbox stays the accessible list");
  const rows = byClass(songs, "shelf-song");
  assert.equal(rows.length, 20, "all 20 songs, though a page of records holds 15");
  assert.equal(byClass(rows[3], "shelf-song-title")[0].textContent, "Água de Teste");
  assert.equal(byClass(rows[3], "shelf-song-by")[0].textContent, "Composer 3");
  assert.ok(rows[0].classList.contains("is-selected"));
  shelf.select(3);
  assert.ok(rows[3].classList.contains("is-selected"));
  assert.ok(!rows[0].classList.contains("is-selected"));
  press(list, "PageDown");
  assert.equal(shelf.page().page, 1, "the records turn to the page of the selected song");
  assert.equal(byClass(songs, "shelf-song").length, 20, "the list does not change with the page");
  assert.ok(byClass(songs, "shelf-song")[18].classList.contains("is-selected"));
});

test("clicking a song far down the list turns the records to its page", () => {
  const { root, shelf } = mount();
  click(byClass(root, "shelf-song")[17]);
  assert.equal(shelf.page().page, 1);
  assert.equal(shelf.selected()?.id, "song-17");
});

test("the search box sits above the list, filters it, and tells the page what was typed", () => {
  /** @type {string[]} */
  const typed = [];
  const { root } = mount({ onSearch: (/** @type {string} */ query) => typed.push(query) });
  const side = byClass(root, "shelf-side")[0];
  const box = byClass(side, "song-search")[0];
  assert.equal(box.tagName, "INPUT");
  assert.equal(box.getAttribute("type"), "search");
  assert.equal(box.getAttribute("aria-label"), "Search songs");
  assert.ok(byClass(side, "shelf-songs")[0], "the list is in the same column as the box");
  box.value = "Água";
  box.dispatchEvent(new FakeEvent("input"));
  assert.deepEqual(typed, ["Água"]);
  assert.ok(byClass(root, "shelf-song").length < 20, "the list shows only the matches");
  assert.ok(byClass(root, "shelf-song").length >= 1);
});

test("clicking a song in the list selects it, and double-clicking arranges it", () => {
  const { root, shelf, arranged } = mount();
  const rows = byClass(root, "shelf-song");
  click(rows[6]);
  assert.equal(shelf.selected()?.id, "song-6");
  assert.deepEqual(arranged, []);
  rows[6].dispatchEvent(new FakeEvent("dblclick"));
  assert.deepEqual(arranged.map((entry) => entry.id), ["song-6"]);
});

test("the panel shows title, composer and one line of facts, with Arrange and Preview", () => {
  const { root, shelf } = mount();
  shelf.select(3);
  const panel = byClass(root, "shelf-info")[0];
  assert.equal(byClass(panel, "shelf-title")[0].textContent, "Água de Teste");
  assert.equal(byClass(panel, "shelf-by")[0].textContent, "Composer 3");
  assert.match(panel.textContent, /Banda Inventada/);
  const facts = byClass(panel, "shelf-facts");
  assert.equal(facts.length, 1, "one line, not four boxes");
  assert.deepEqual(facts[0].children.map((fact) => fact.textContent), ["Eb minor", "123 BPM", "4/4", "32 bars"]);
  assert.equal(all(panel).filter((element) => element.tagName === "DT" || element.tagName === "DD").length, 0);
  assert.ok(button(panel, "Arrange").classList.contains("primary"));
  assert.ok(button(panel, "Preview"));
  assert.equal(byClass(panel, "shelf-sprite").length, 1, "the panel shows the song's sprite");
});

test("Arrange and Preview hand the selected song to the page", () => {
  const { root, shelf, arranged, previewed } = mount();
  shelf.select(2);
  click(button(root, "Arrange"));
  click(button(root, "Preview"));
  assert.deepEqual(arranged.map((entry) => entry.id), ["song-2"]);
  assert.deepEqual(previewed.map((entry) => entry.id), ["song-2"]);
});

test("a song that cannot be arranged says why and offers no Arrange", () => {
  const entries = [song(0, { route: undefined, error: "bar 3: the meter 11/16 is not supported" }), song(1)];
  const { root, list, arranged } = mount({ entries });
  click(tile(root, "Examples")); // a song with an error stays out of Popular
  assert.match(panelText(root), /cannot be arranged \(bar 3: the meter 11\/16 is not supported\)/);
  assert.equal(all(root).filter((element) => element.tagName === "BUTTON" && element.textContent === "Arrange").length, 0);
  press(list, "Enter");
  assert.equal(arranged.length, 0);
});

// --- Keyboard and pages -------------------------------------------------------------------------

test("arrow keys move the selection; past the page's end they turn the page", () => {
  const { root, list, shelf } = mount();
  const event = press(list, "ArrowRight");
  assert.ok(event.defaultPrevented, "the page does not scroll");
  assert.equal(shelf.page().index, 1);
  assert.equal(list.getAttribute("aria-activedescendant"), optionsOf(root)[1].id);
  assert.match(panelText(root), /Song 01/);
  press(list, "End");
  press(list, "ArrowRight");
  assert.deepEqual({ page: shelf.page().page, index: shelf.page().index }, { page: 1, index: 15 });
  assert.equal(optionsOf(root).length, 5, "the last page holds the other 5 songs");
  assert.equal(pagerText(root), "Page 2 of 2");
  assert.match(String(list.getAttribute("aria-label")), /page 2 of 2/);
});

test("PageDown and PageUp turn pages, Home goes to the page's first song, Enter arranges", () => {
  const { list, shelf, arranged } = mount();
  press(list, "ArrowRight");
  press(list, "PageDown");
  assert.equal(shelf.page().index, 16);
  press(list, "PageUp");
  assert.equal(shelf.page().index, 1);
  press(list, "End");
  press(list, "Home");
  assert.equal(shelf.page().index, 0);
  const unhandled = press(list, "q");
  assert.equal(unhandled.defaultPrevented, false, "other keys pass through");
  press(list, "Enter");
  assert.deepEqual(arranged.map((entry) => entry.id), ["song-0"]);
});

test("the page arrows sit on the stage's edges, turn pages and are disabled at the ends; a counter stays under it", () => {
  const { root, shelf } = mount();
  const stage = byClass(root, "shelf-stage")[0];
  const previous = all(stage).find((element) => element.getAttribute("aria-label") === "Previous page");
  const next = all(stage).find((element) => element.getAttribute("aria-label") === "Next page");
  assert.ok(previous && next, "both arrows are inside the stage, over the records");
  assert.ok(previous.classList.contains("shelf-arrow") && next.classList.contains("shelf-arrow"));
  assert.ok(previous.classList.contains("is-previous") && next.classList.contains("is-next"));
  assert.equal(previous.disabled, true);
  click(next);
  assert.equal(shelf.page().page, 1);
  assert.equal(next.disabled, true);
  assert.equal(previous.disabled, false);
  click(previous);
  assert.equal(shelf.page().page, 0);
  assert.equal(all(stage).includes(byClass(root, "shelf-page")[0]), false, "the counter is not on the records");
});

test("a list that fits one page needs no arrows", () => {
  const { root, shelf } = mount({ entries: twenty().slice(0, 5) });
  const arrows = byClass(root, "shelf-arrow");
  assert.equal(arrows.length, 2);
  assert.ok(arrows.every((arrow) => arrow.hidden));
  shelf.setEntries(twenty());
  assert.ok(arrows.every((arrow) => !arrow.hidden), "they return with a second page");
});

test("a phone-width shelf shows 9 songs a page, and resizing keeps the selected song", () => {
  const { root, shelf } = mount({}, 375);
  assert.equal(optionsOf(root).length, 9);
  assert.deepEqual({ perPage: shelf.page().perPage, columns: shelf.page().columns, pages: shelf.page().pages }, { perPage: 9, columns: 3, pages: 3 });
  assert.equal(root.styleValues["--shelf-columns"], "3", "the 2D grid's CSS reads the same column count");
  shelf.select(10);
  root.clientWidth = 700;
  shelf.resize();
  assert.equal(shelf.page().perPage, 15);
  assert.equal(root.styleValues["--shelf-columns"], "5");
  assert.equal(shelf.page().index, 10);
  assert.equal(shelf.page().page, 0);
});

test("the columns follow the stage width, and so do the page size and the keyboard's rows", () => {
  const many = Array.from({ length: 80 }, (_, i) => song(i));
  const expected = [[375, 3], [700, 5], [824, 7], [1000, 9]];
  for (const [width, columns] of expected) {
    const { root, shelf, list } = mount({ entries: many }, width);
    assert.equal(shelf.page().columns, columns, `${width} px`);
    assert.equal(shelf.page().perPage, columns * 3);
    assert.equal(optionsOf(root).length, columns * 3);
    assert.equal(root.styleValues["--shelf-columns"], String(columns));
    press(list, "ArrowDown");
    assert.equal(shelf.page().index, columns, "one row down is one more column along the list");
  }
});

// --- Search and a growing catalog ---------------------------------------------------------------

test("a query filters the shelf and selects its first match; an empty query restores the catalog", () => {
  const { root, shelf } = mount();
  shelf.select(12);
  shelf.setQuery("agua");
  assert.deepEqual(optionsOf(root).map((option) => option.textContent.includes("Água de Teste")), [true]);
  assert.equal(shelf.page().index, 0);
  shelf.setQuery("nothing like this");
  assert.equal(optionsOf(root).length, 0);
  const empty = byClass(root, "shelf-empty")[0];
  assert.equal(empty.hidden, false);
  assert.match(empty.textContent, /No song in the catalog matches/);
  assert.equal(pagerText(root), "Page 1 of 1");
  shelf.setQuery("");
  assert.equal(optionsOf(root).length, 15);
  assert.equal(empty.hidden, true);
});

test("external results follow the local matches of a query", () => {
  const { root, shelf } = mount();
  shelf.setQuery("song 1");
  const local = shelf.page().total;
  shelf.setExternal([{ source: "web", id: "1", title: "Song 1 elsewhere", composer: "", license: "", format: "midi", page: "", open: "/files/web/1" }]);
  assert.equal(shelf.page().total, local + 1);
  assert.match(optionsOf(root).at(-1)?.textContent ?? "", /Song 1 elsewhere/);
});

test("a catalog that grows keeps the selected song", () => {
  const { shelf } = mount({ entries: twenty().slice(0, 3) });
  shelf.select(2);
  shelf.setEntries(twenty());
  assert.equal(shelf.selected()?.id, "song-2");
  assert.equal(shelf.page().total, 20);
});

test("before the catalog arrives, the stage says it is loading", () => {
  const { root } = mount({ entries: [] });
  assert.match(byClass(root, "shelf-empty")[0].textContent, /Loading/);
});

// --- 2D grid and 3D scene -----------------------------------------------------------------------

test("without WebGL the options are a 2D grid of sprite canvases that select on click", () => {
  const { root, list, shelf, document } = mount({ webgl: false });
  assert.ok(root.classList.contains("is-2d"));
  assert.ok(!root.classList.contains("is-3d"));
  const option = optionsOf(root)[4];
  const sprite = byClass(option, "shelf-sprite")[0];
  assert.equal(sprite.tagName, "CANVAS");
  assert.ok(sprite.painted.length > 20, "the sprite is drawn");
  assert.match(String(byClass(option, "shelf-disc")[0].styleValues["--label"]), /^#[0-9A-F]{6}$/);
  assert.equal(byClass(option, "shelf-record-label")[0].textContent, "Song 04", "the 2D grid names each record");
  assert.equal(byClass(option, "shelf-record-label")[0].getAttribute("aria-hidden"), "true", "the option's own name is read once");
  click(option);
  assert.equal(shelf.page().index, 4);
  assert.equal(document.activeElement, list, "the listbox takes the focus, so the keys work next");
});

test("with WebGL the scene draws the page, follows the selection and picks records", async () => {
  const scene = fakeScene();
  const { root, list, shelf } = mount({ webgl: true, reducedMotion: true, sceneFactory: async () => scene.module });
  assert.ok(root.classList.contains("is-3d"));
  assert.ok(root.classList.contains("reduce-motion"));
  await settle();
  const [create, ...rest] = scene.calls;
  assert.equal(create[0], "create");
  assert.ok(byClass(root, "shelf-canvas").includes(create[1]), "the scene gets the canvas host");
  assert.deepEqual(create[2], { reducedMotion: true });
  assert.deepEqual(rest[0], ["setPage", twenty().slice(0, 15).map((entry) => entry.id), 0]);
  press(list, "ArrowRight");
  assert.deepEqual(scene.calls.at(-1), ["select", 1]);
  press(list, "PageDown");
  assert.deepEqual(scene.calls.at(-1), ["setPage", twenty().slice(15).map((entry) => entry.id), 1]);
  scene.pick(3);
  assert.equal(shelf.page().index, 18);
});

test("a lost WebGL context, or a scene that fails to load, falls back to the 2D grid and keeps the selection", async () => {
  const scene = fakeScene();
  const { root, shelf } = mount({ webgl: true, sceneFactory: async () => scene.module });
  await settle();
  shelf.select(6);
  const host = byClass(root, "shelf-canvas")[0];
  host.dispatchEvent(new FakeEvent("webglcontextlost"));
  assert.ok(root.classList.contains("is-2d"));
  assert.deepEqual(scene.calls.at(-1), ["dispose"]);
  assert.equal(shelf.page().index, 6);

  const failing = mount({ webgl: true, sceneFactory: async () => Promise.reject(new Error("no three.js")) });
  await settle();
  assert.ok(failing.root.classList.contains("is-2d"));
});

test("destroy empties the shelf and stops the scene", async () => {
  const scene = fakeScene();
  const { root, shelf } = mount({ webgl: true, sceneFactory: async () => scene.module });
  await settle();
  shelf.destroy();
  assert.equal(root.children.length, 0);
  assert.deepEqual(scene.calls.at(-1), ["dispose"]);
});

// --- What the page never says ------------------------------------------------------------------

test("no text or attribute names a source site, a PS2 memory card, or packs facts with dots", () => {
  const { root, shelf, list } = mount();
  /** @type {string[]} */
  const seen = [];
  const collect = () => {
    for (const element of all(root)) {
      seen.push(element.ownText, ...element.attributes.values(), ...Object.values(element.styleValues));
    }
  };
  collect();
  for (let i = 0; i < 20; i++) {
    shelf.select(i);
    collect();
  }
  press(list, "PageDown");
  collect();
  const text = seen.join("\n");
  assert.doesNotMatch(text, /kauffmann|thesession|the session|mutopia|bitmidi|imslp|nottingham|pdmx/i);
  assert.doesNotMatch(text, /PS2|memory card|save data|original page/i);
  assert.doesNotMatch(text, / · /);
});

// --- Playlists ---------------------------------------------------------------------------------

/**
 * @param {number} n
 * @param {string} artist
 * @param {number} pop
 */
const mpbSong = (n, artist, pop) =>
  song(200 + n, { source: "mpb", t: `${artist} Song ${n}`, c: "", p: artist, pop, route: { download: `https://example.org/${n}.mid` } });

/** A small library: popular tunes, examples, folk tunes and MPB songs that need a download. */
function library() {
  return [
    mpbSong(1, "Alba", 90), mpbSong(2, "Alba", 80), mpbSong(3, "Alba", 70), mpbSong(4, "Alba", 60), mpbSong(5, "Alba", 50),
    mpbSong(6, "Bo", 95), mpbSong(7, "Bo", 5),
    song(30, { source: "nottingham", t: "Reel Low", pop: 1 }),
    song(31, { source: "nottingham", t: "Reel High", pop: 60 }),
    song(1, { source: "examples", t: "Example Two", order: 2, pop: 0 }),
    song(0, { source: "examples", t: "Example One", order: 1, pop: 0 }),
    song(40, { source: "pdmx", t: "Sonata", pop: 30 }),
  ];
}

test("the chooser is a row of toggle buttons, one per playlist, Popular chosen at first", () => {
  const { root } = mount({ entries: library() });
  const group = byClass(root, "shelf-playlists")[0];
  assert.equal(group.getAttribute("role"), "group");
  assert.equal(group.getAttribute("aria-label"), "Playlists");
  assert.deepEqual(tileNames(root), ["Popular", "Examples", "MPB", "Folk tunes", "Classical & standards"]);
  for (const element of tiles(root)) {
    assert.equal(element.tagName, "BUTTON", "keyboard reachable");
    assert.equal(element.getAttribute("type"), "button");
  }
  assert.deepEqual(pressedTiles(root).map((element) => element.textContent.slice(0, 7)), ["Popular"]);
  assert.equal(byClass(tile(root, "MPB"), "shelf-tile-count")[0].textContent, "7 songs, 1 album");
  assert.equal(viewText(root), "Popular: 5 songs", "the five songs that open in one click");
});

test("each tile has a cover: the sprite of the playlist's most popular song", () => {
  const { root } = mount({ entries: library() });
  const cover = byClass(tile(root, "Folk tunes"), "shelf-sprite")[0];
  assert.equal(cover.tagName, "CANVAS");
  assert.ok(cover.painted.length > 20, "the sprite is drawn");
  const sameSprite = mount({ entries: [song(31, { source: "nottingham", t: "Reel High", pop: 60 })] });
  assert.deepEqual(cover.painted, byClass(tile(sameSprite.root, "Folk tunes"), "shelf-sprite")[0].painted);
});

test("every list is ordered by popularity, whatever the order of the catalog", () => {
  const { root, shelf } = mount({ entries: library() });
  assert.deepEqual(rowTitles(root), ["Reel High", "Sonata", "Reel Low", "Example One", "Example Two"]);
  assert.equal(shelf.selected()?.t, "Reel High");
  click(tile(root, "Folk tunes"));
  assert.deepEqual(rowTitles(root), ["Reel High", "Reel Low"]);
});

test("choosing a playlist shows only its songs, in the records and in the side list, and selects its first", () => {
  const { root, shelf } = mount({ entries: library() });
  shelf.select(2);
  click(tile(root, "Examples"));
  assert.deepEqual(rowTitles(root), ["Example One", "Example Two"], "the examples keep their own order");
  assert.equal(optionsOf(root).length, 2);
  assert.equal(shelf.page().index, 0);
  assert.equal(shelf.page().total, 2);
  assert.deepEqual(pressedTiles(root).map((element) => byClass(element, "shelf-tile-name")[0].textContent), ["Examples"]);
  assert.equal(viewText(root), "Examples: 2 songs");
  assert.equal(String(byRole(root, "listbox")[0].getAttribute("aria-label")), "Songs, page 1 of 1");
});

test("the listbox keeps its roles for the current playlist", () => {
  const { root, list, shelf } = mount({ entries: library() });
  click(tile(root, "Folk tunes"));
  const options = optionsOf(root);
  assert.equal(options.length, 2);
  assert.equal(options[0].getAttribute("aria-setsize"), "2");
  assert.equal(list.getAttribute("aria-activedescendant"), options[0].id);
  press(list, "ArrowRight");
  assert.equal(list.getAttribute("aria-activedescendant"), options[1].id);
  assert.equal(shelf.selected()?.t, "Reel Low");
});

test("a song that needs a download is marked in the side list and stays out of Popular", () => {
  const { root } = mount({ entries: library() });
  assert.ok(!rowTitles(root).some((title) => title.startsWith("Alba") || title.startsWith("Bo")));
  click(tile(root, "MPB"));
  const rows = byClass(root, "shelf-song");
  assert.ok(rows.length > 0);
  for (const row of rows) assert.equal(byClass(row, "shelf-song-get")[0]?.textContent, "↓");
  click(tile(root, "Back to playlists"));
  click(tile(root, "Folk tunes"));
  assert.equal(byClass(root, "shelf-song-get").length, 0, "songs that open in one click have no hint");
});

/** A shelf on the MPB playlist with the first song selected, and the download handlers recorded. */
function mountMpb(extra = {}) {
  /** @type {any[]} */
  const downloaded = [];
  /** @type {any[]} */
  const opened = [];
  const mounted = mount({
    entries: library(),
    onDownload: (/** @type {any} */ entry) => downloaded.push(entry),
    onOpenDownloaded: (/** @type {any} */ entry) => opened.push(entry),
    ...extra,
  });
  click(tile(mounted.root, "MPB"));
  click(tile(mounted.root, "All MPB"));
  return { ...mounted, downloaded, opened, panel: byClass(mounted.root, "shelf-info")[0] };
}

test("a song that needs a download shows a primary Download MIDI button and a one-line hint, not Arrange or Preview", () => {
  const { panel, downloaded } = mountMpb();
  const get = button(panel, "Download MIDI");
  assert.ok(get.classList.contains("primary"));
  assert.equal(byClass(get, "shelf-icon").length, 1, "with a download icon");
  assert.equal(byClass(get, "shelf-icon")[0].getAttribute("aria-hidden"), "true");
  assert.equal(byClass(panel, "shelf-hint")[0].textContent, "Then open the downloaded file here.");
  const names = all(panel).filter((element) => element.tagName === "BUTTON").map((element) => element.textContent);
  assert.deepEqual(names, ["Download MIDI"], "no Arrange, no Preview, nothing else to choose");
  assert.deepEqual(downloaded, []);
  click(get);
  assert.deepEqual(downloaded.map((entry) => entry.id), ["song-206"], "the page is told which song");
});

test("after Download MIDI the panel offers Open downloaded file as its primary action", () => {
  const { root, shelf, panel, opened, downloaded } = mountMpb();
  click(button(panel, "Download MIDI"));
  const info = () => byClass(root, "shelf-info")[0];
  const open = button(info(), "Open downloaded file");
  assert.ok(open.classList.contains("primary"));
  assert.equal(byClass(info(), "shelf-hint").length, 0, "the hint has done its work");
  assert.ok(button(info(), "Download again"), "a download that failed can be repeated");
  click(open);
  assert.deepEqual(opened.map((entry) => entry.id), ["song-206"]);
  assert.equal(downloaded.length, 1);
  shelf.select(1);
  assert.ok(button(info(), "Download MIDI"), "another song starts at the download");
  shelf.select(0);
  assert.ok(button(info(), "Open downloaded file"), "and the first one remembers it was downloaded");
});

test("Enter on a song that needs a download starts the download, then opens the file", () => {
  const { list, downloaded, opened } = mountMpb();
  press(list, "Enter");
  assert.equal(downloaded.length, 1);
  assert.equal(opened.length, 0);
  press(list, "Enter");
  assert.equal(opened.length, 1);
});

test("without download handlers a song that needs a download keeps Arrange and Preview", () => {
  const { panel } = mountMpb({ onDownload: undefined, onOpenDownloaded: undefined });
  assert.ok(button(panel, "Arrange"));
  assert.ok(button(panel, "Preview"));
});

test("MPB opens a second level: its artist albums, with a back control and an All MPB button", () => {
  const { root, shelf } = mount({ entries: library() });
  click(tile(root, "MPB"));
  assert.deepEqual(tileNames(root), ["Back to playlists", "All MPB", "Alba", "Other artists"]);
  assert.deepEqual(pressedTiles(root).map((element) => byClass(element, "shelf-tile-name")[0].textContent), ["All MPB"]);
  assert.equal(shelf.page().total, 7, "all of MPB until an album is chosen");
  assert.deepEqual(rowTitles(root).slice(0, 2), ["Bo Song 6", "Alba Song 1"], "by popularity");

  click(tile(root, "Alba"));
  assert.deepEqual(rowTitles(root), ["Alba Song 1", "Alba Song 2", "Alba Song 3", "Alba Song 4", "Alba Song 5"]);
  assert.equal(viewText(root), "MPB, Alba: 5 songs");
  assert.deepEqual(pressedTiles(root).map((element) => byClass(element, "shelf-tile-name")[0].textContent), ["Alba"]);

  click(tile(root, "All MPB"));
  assert.equal(shelf.page().total, 7);

  click(tile(root, "Back to playlists"));
  assert.deepEqual(tileNames(root), ["Popular", "Examples", "MPB", "Folk tunes", "Classical & standards"]);
  assert.equal(pressedTiles(root).length, 1);
  assert.equal(shelf.page().total, 7, "MPB stays chosen until another playlist is");
  click(tile(root, "Popular"));
  assert.equal(viewText(root), "Popular: 5 songs");
});

test("the keyboard reaches the tiles in order, and a tile keeps the focus after it is pressed", () => {
  const { root, document } = mount({ entries: library() });
  click(tile(root, "Folk tunes"));
  assert.equal(document.activeElement, tile(root, "Folk tunes"));
  click(tile(root, "MPB"));
  assert.equal(document.activeElement, tile(root, "All MPB"), "the albums row takes the focus at its first album");
  click(tile(root, "Back to playlists"));
  assert.equal(document.activeElement, tile(root, "MPB"), "back returns the focus to MPB");
});

test("typing in the search box searches every song, named Search results, and clearing returns to the playlist", () => {
  const { root, shelf } = mount({ entries: library() });
  click(tile(root, "Folk tunes"));
  const box = shelf.searchBox;
  box.value = "song";
  box.dispatchEvent(new FakeEvent("input"));
  assert.match(viewText(root), /^Search results: \d+ songs?$/);
  assert.ok(rowTitles(root).some((title) => title.startsWith("Alba")), "MPB songs are found though Popular and Folk tunes lack them");
  assert.equal(pressedTiles(root).length, 0, "no playlist is the current view while searching");
  box.value = "";
  box.dispatchEvent(new FakeEvent("input"));
  assert.deepEqual(rowTitles(root), ["Reel High", "Reel Low"], "back to the playlist that was chosen");
  assert.equal(viewText(root), "Folk tunes: 2 songs");
  assert.equal(pressedTiles(root).length, 1);
});

test("a search keeps the text ranking and breaks ties by popularity", () => {
  const { shelf, root } = mount({ entries: library() });
  shelf.setQuery("reel");
  assert.deepEqual(rowTitles(root), ["Reel High", "Reel Low"]);
  shelf.setQuery("alba");
  assert.deepEqual(rowTitles(root), ["Alba Song 1", "Alba Song 2", "Alba Song 3", "Alba Song 4", "Alba Song 5"]);
  shelf.setQuery("o");
  assert.equal(shelf.page().total, 5, "one letter shows the playlist, not a search");
  shelf.setQuery("example");
  assert.deepEqual(rowTitles(root), ["Example One", "Example Two"]);
});

test("choosing a playlist while a search is typed clears the search box", () => {
  /** @type {string[]} */
  const typed = [];
  const { root, shelf } = mount({ entries: library(), onSearch: (/** @type {string} */ query) => typed.push(query) });
  shelf.setQuery("alba");
  click(tile(root, "Examples"));
  assert.equal(shelf.searchBox.value, "");
  assert.deepEqual(rowTitles(root), ["Example One", "Example Two"]);
  assert.equal(typed.at(-1), "");
});

test("the chosen playlist is remembered in localStorage and chosen again by the next shelf", () => {
  const storage = fakeStorage();
  const first = mount({ entries: library(), storage });
  click(tile(first.root, "Folk tunes"));
  assert.equal(PLAYLIST_KEY, "nes-arranger-playlist");
  assert.equal(storage.items.get(PLAYLIST_KEY), "folk");
  const second = mount({ entries: library(), storage });
  assert.equal(viewText(second.root), "Folk tunes: 2 songs");
});

test("an unknown remembered playlist, or a storage that throws, gives Popular", () => {
  const unknown = mount({ entries: library(), storage: fakeStorage({ "nes-arranger-playlist": "gone" }) });
  assert.equal(viewText(unknown.root), "Popular: 5 songs");
  const broken = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  const { root } = mount({ entries: library(), storage: broken });
  click(tile(root, "Examples"));
  assert.equal(viewText(root), "Examples: 2 songs", "choosing still works");
});

test("a remembered playlist applies when the catalog arrives after the shelf", () => {
  const storage = fakeStorage({ "nes-arranger-playlist": "folk" });
  const { root, shelf } = mount({ entries: [], storage });
  shelf.setEntries(library().filter((entry) => entry.source === "examples"));
  assert.equal(viewText(root), "Popular: 2 songs", "until the remembered playlist exists");
  shelf.setEntries(library());
  assert.equal(viewText(root), "Folk tunes: 2 songs");
  assert.equal(storage.items.get(PLAYLIST_KEY), "folk", "the fallback did not overwrite the choice");
});

test("the visitor's own songs head Popular, have a Your songs playlist, and a new one is selected first", () => {
  const { root, shelf } = mount({ entries: library() });
  assert.ok(!tileNames(root).includes("Your songs"));
  click(tile(root, "Folk tunes"));
  const own = song(100, { source: "local", t: "My Tune", c: "Your file", route: { local: true } });
  shelf.setEntries([own, ...library()]);
  assert.deepEqual(tileNames(root).slice(0, 3), ["Popular", "Your songs", "Examples"]);
  assert.equal(viewText(root), "Popular: 6 songs", "a new own song brings Popular back");
  assert.equal(shelf.selected()?.t, "My Tune");
  click(tile(root, "Your songs"));
  assert.deepEqual(rowTitles(root), ["My Tune"]);
  shelf.setEntries([own, ...library()]);
  assert.deepEqual(rowTitles(root), ["My Tune"], "the same songs change nothing");
});

// --- Touch and wheel ---------------------------------------------------------------------------

const point = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ time) => ({ x, y, time });

test("a quick, mostly horizontal drag of 40 pixels or more is a swipe: left turns to the next page, right to the previous", () => {
  assert.equal(swipeGesture(point(200, 100, 0), point(140, 105, 200)), "next");
  assert.equal(swipeGesture(point(100, 100, 0), point(160, 90, 200)), "previous");
  assert.equal(swipeGesture(point(100, 100, 0), point(140, 100, 100)), "previous", "exactly 40 pixels counts");
});

test("a short drag, a vertical drag and a slow drag are not swipes", () => {
  assert.equal(swipeGesture(point(100, 100, 0), point(139, 100, 100)), "none", "39 pixels is not enough");
  assert.equal(swipeGesture(point(100, 100, 0), point(160, 190, 100)), "none", "mostly vertical: the page scrolls");
  assert.equal(swipeGesture(point(100, 100, 0), point(220, 100, 2000)), "none", "too slow");
});

test("a touch that hardly moves is a tap", () => {
  assert.equal(swipeGesture(point(100, 100, 0), point(103, 102, 80)), "tap");
  assert.equal(swipeGesture(point(100, 100, 0), point(100, 100, 900)), "tap", "a long press still picks");
});

test("a horizontal wheel, or shift with the wheel, gives a page-turning delta; a vertical wheel gives none", () => {
  assert.equal(wheelDelta({ deltaX: 50, deltaY: 3, shiftKey: false }), 50);
  assert.equal(wheelDelta({ deltaX: -30, deltaY: 0, shiftKey: false }), -30);
  assert.equal(wheelDelta({ deltaX: 0, deltaY: 40, shiftKey: false }), 0, "normal scrolling is left alone");
  assert.equal(wheelDelta({ deltaX: 5, deltaY: 40, shiftKey: false }), 0);
  assert.equal(wheelDelta({ deltaX: 0, deltaY: 40, shiftKey: true }), 40, "shift turns the vertical wheel sideways");
  assert.equal(wheelDelta({ deltaX: -40, deltaY: 0, shiftKey: true }), -40, "some browsers already did that");
});

/**
 * One finger's drag on the stage: down, up, and the click the browser may send after.
 * @param {FakeElement} stage
 * @param {number[]} from x, y
 * @param {number[]} to x, y
 * @param {number} [duration] in milliseconds
 * @param {string} [pointerType]
 */
function drag(stage, from, to, duration = 150, pointerType = "touch") {
  stage.dispatchEvent(new FakeEvent("pointerdown", { pointerType, isPrimary: true, clientX: from[0], clientY: from[1], timeStamp: 1000 }));
  stage.dispatchEvent(new FakeEvent("pointerup", { pointerType, isPrimary: true, clientX: to[0], clientY: to[1], timeStamp: 1000 + duration }));
}

test("swiping the stage turns the page, and the click that follows does not pick a record", () => {
  const { root, shelf } = mount();
  const stage = byClass(root, "shelf-stage")[0];
  drag(stage, [250, 100], [150, 108]);
  assert.equal(shelf.page().page, 1, "a swipe to the left shows the next page");
  const swipeClick = new FakeEvent("click");
  stage.dispatchEvent(swipeClick);
  assert.ok(swipeClick.propagationStopped, "the scene's click handler does not see it");
  assert.ok(swipeClick.defaultPrevented);
  const laterClick = new FakeEvent("click");
  stage.dispatchEvent(laterClick);
  assert.equal(laterClick.propagationStopped, false, "only the click right after a swipe is stopped");
  drag(stage, [100, 100], [210, 96]);
  assert.equal(shelf.page().page, 0, "a swipe to the right shows the previous page");
});

test("a swipe past the first or last page stays where it is", () => {
  const { root, shelf } = mount();
  const stage = byClass(root, "shelf-stage")[0];
  drag(stage, [100, 100], [220, 100]);
  assert.equal(shelf.page().page, 0);
  drag(stage, [220, 100], [100, 100]);
  drag(stage, [220, 100], [100, 100]);
  assert.equal(shelf.page().page, 1);
});

test("a tap, a vertical drag and a mouse drag do not turn the page, and their clicks go through", () => {
  const { root, shelf } = mount();
  const stage = byClass(root, "shelf-stage")[0];
  drag(stage, [100, 100], [102, 101], 60);
  drag(stage, [100, 100], [110, 220]);
  drag(stage, [250, 100], [100, 100], 150, "mouse");
  assert.equal(shelf.page().page, 0);
  const tapClick = new FakeEvent("click");
  stage.dispatchEvent(tapClick);
  assert.equal(tapClick.propagationStopped, false);
});

test("a cancelled touch (the browser took it to scroll the page) turns nothing", () => {
  const { root, shelf } = mount();
  const stage = byClass(root, "shelf-stage")[0];
  stage.dispatchEvent(new FakeEvent("pointerdown", { pointerType: "touch", isPrimary: true, clientX: 250, clientY: 100, timeStamp: 1000 }));
  stage.dispatchEvent(new FakeEvent("pointercancel", { pointerType: "touch" }));
  stage.dispatchEvent(new FakeEvent("pointerup", { pointerType: "touch", isPrimary: true, clientX: 100, clientY: 100, timeStamp: 1100 }));
  assert.equal(shelf.page().page, 0);
});

test("a horizontal wheel or shift with the wheel turns pages; a vertical wheel scrolls the page as usual", () => {
  const { root, shelf } = mount();
  const stage = byClass(root, "shelf-stage")[0];
  const vertical = new FakeEvent("wheel", { deltaX: 0, deltaY: 120, shiftKey: false, timeStamp: 1000 });
  stage.dispatchEvent(vertical);
  assert.equal(shelf.page().page, 0);
  assert.equal(vertical.defaultPrevented, false, "the page may still scroll");

  const sideways = new FakeEvent("wheel", { deltaX: 100, deltaY: 0, shiftKey: false, timeStamp: 2000 });
  stage.dispatchEvent(sideways);
  assert.equal(shelf.page().page, 1);
  assert.ok(sideways.defaultPrevented, "no browser back-swipe while turning pages");

  const quick = new FakeEvent("wheel", { deltaX: -100, deltaY: 0, shiftKey: false, timeStamp: 2100 });
  stage.dispatchEvent(quick);
  assert.equal(shelf.page().page, 1, "a trackpad's flick turns one page, not all of them");

  stage.dispatchEvent(new FakeEvent("wheel", { deltaX: 0, deltaY: -100, shiftKey: true, timeStamp: 3000 }));
  assert.equal(shelf.page().page, 0, "shift with the wheel turns pages: up goes back");
  stage.dispatchEvent(new FakeEvent("wheel", { deltaX: 0, deltaY: 100, shiftKey: true, timeStamp: 4000 }));
  assert.equal(shelf.page().page, 1, "down goes forward");
});

test("small wheel steps add up before a page turns", () => {
  const { root, shelf } = mount();
  const stage = byClass(root, "shelf-stage")[0];
  stage.dispatchEvent(new FakeEvent("wheel", { deltaX: 20, deltaY: 0, shiftKey: false, timeStamp: 1000 }));
  stage.dispatchEvent(new FakeEvent("wheel", { deltaX: 20, deltaY: 0, shiftKey: false, timeStamp: 1050 }));
  assert.equal(shelf.page().page, 0);
  stage.dispatchEvent(new FakeEvent("wheel", { deltaX: 30, deltaY: 0, shiftKey: false, timeStamp: 1100 }));
  assert.equal(shelf.page().page, 1);
});
