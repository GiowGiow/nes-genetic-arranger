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

import { createSongShelf, factsOf, keyLabel, stepSelection, webglAvailable } from "../src/ui/song-shelf.js";

// --- A fake document ---------------------------------------------------------------------------

class FakeEvent {
  /** @param {string} type @param {Record<string, unknown>} [fields] */
  constructor(type, fields = {}) {
    this.type = type;
    this.defaultPrevented = false;
    Object.assign(this, fields);
  }

  preventDefault() {
    this.defaultPrevented = true;
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
    source: i < 3 ? "examples" : "mpb",
    t: i === 3 ? "ÁGUA DE TESTE" : `Song ${String(i).padStart(2, "0")}`,
    c: `Composer ${i}`,
    p: i === 3 ? "Banda Inventada" : "",
    u: `https://www.beakauffmann.com/mpb_s/song-${i}.html`,
    license: "all-rights-reserved",
    seed: 1000 + i,
    route: { server: `/songs/mpb/song-${i}.abc` },
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
    ...options,
  });
  const list = byRole(root, "listbox")[0];
  return { document, root, shelf, list, arranged, previewed };
}

/** @param {FakeElement} root */
const optionsOf = (root) => byRole(root, "option");
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

test("keys read as written, and facts as labeled values with a dash when unknown", () => {
  assert.equal(keyLabel("e- minor"), "Eb minor");
  assert.equal(keyLabel("f# minor"), "F# minor");
  assert.equal(keyLabel("C major"), "C major");
  assert.equal(keyLabel(""), "—");
  assert.deepEqual(factsOf(song(1)), [
    ["Key", "Eb minor"],
    ["Tempo", "121 BPM"],
    ["Meter", "4/4"],
    ["Bars", "32"],
  ]);
  assert.deepEqual(factsOf({ id: "x", t: "X" }), [
    ["Key", "—"],
    ["Tempo", "—"],
    ["Meter", "—"],
    ["Bars", "—"],
  ]);
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

test("the panel shows title, composer and the facts as labeled values, with Arrange and Preview", () => {
  const { root, shelf } = mount();
  shelf.select(3);
  const panel = byClass(root, "shelf-info")[0];
  assert.equal(byClass(panel, "shelf-title")[0].textContent, "Água de Teste");
  assert.equal(byClass(panel, "shelf-by")[0].textContent, "Composer 3");
  assert.match(panel.textContent, /Banda Inventada/);
  const terms = all(panel).filter((element) => element.tagName === "DT").map((element) => element.textContent);
  const values = all(panel).filter((element) => element.tagName === "DD").map((element) => element.textContent);
  assert.deepEqual(terms, ["Key", "Tempo", "Meter", "Bars"]);
  assert.deepEqual(values, ["Eb minor", "123 BPM", "4/4", "32"]);
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

test("the pager buttons turn pages and are disabled at the ends", () => {
  const { root, shelf } = mount();
  const previous = all(root).find((element) => element.getAttribute("aria-label") === "Previous page");
  const next = all(root).find((element) => element.getAttribute("aria-label") === "Next page");
  assert.ok(previous && next);
  assert.equal(previous.disabled, true);
  click(next);
  assert.equal(shelf.page().page, 1);
  assert.equal(next.disabled, true);
  assert.equal(previous.disabled, false);
  click(previous);
  assert.equal(shelf.page().page, 0);
});

test("a phone-width shelf shows 9 songs a page, and resizing keeps the selected song", () => {
  const { root, shelf } = mount({}, 375);
  assert.equal(optionsOf(root).length, 9);
  assert.deepEqual({ perPage: shelf.page().perPage, columns: shelf.page().columns, pages: shelf.page().pages }, { perPage: 9, columns: 3, pages: 3 });
  assert.equal(root.styleValues["--shelf-columns"], "3", "the 2D grid's CSS reads the same column count");
  shelf.select(10);
  root.clientWidth = 900;
  shelf.resize();
  assert.equal(shelf.page().perPage, 15);
  assert.equal(root.styleValues["--shelf-columns"], "5");
  assert.equal(shelf.page().index, 10);
  assert.equal(shelf.page().page, 0);
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
