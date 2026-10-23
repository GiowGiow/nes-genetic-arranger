// @ts-check
// Tests for ui/catalog-glue.js: the code between the song shelf and the rest of the page. They
// read as what a visitor does with a record: press Arrange or Preview, search, download a song
// whose site allows no direct read and open the file they saved. The shelf, the input panel and
// the network are fakes; the song cache and the catalog reader are the real ones.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createSongCache } from "../src/core/song-cache.js";
import { createCatalogGlue } from "../src/ui/catalog-glue.js";
import { FakeDocument, FakeElement, createManualClock } from "./fake-dom.js";

/** A record of the Korobeiniki ABC in the repository. */
const KOROBEINIKI = { id: "korobeiniki", source: "examples", t: "Korobeiniki", c: "", route: { abc: "data/leadsheets/korobeiniki.abc", tune: 0 } };

/** A record of a song from a site that allows no direct read: it is downloaded by hand. */
const AQUARELA = { id: "aquarela", source: "mpb", t: "Aquarela", c: "", route: { download: "https://example.org/aquarela.mid" } };

/** A record that is a page of another site, with no file to read. */
const PAGE_ONLY = { id: "page", source: "elsewhere", t: "A page", c: "", route: { link: "https://example.org/page" } };

/** A tiny ABC tune, as the repository serves it. */
const ABC_TEXT = "X:1\nT:Korobeiniki\nM:4/4\nL:1/4\nK:Am\nA B c d|\n";

/**
 * A glue on fakes, with a record of everything it does to them.
 *
 * @param {{fetchFn?: any, loadCatalog?: any, cachedKeys?: string[], win?: any, loaded?: () => any}} [parts]
 */
function setUp(parts = {}) {
  const document = new FakeDocument();
  const make = (/** @type {string} */ tag) => new FakeElement(tag, document);
  const elements = {
    status: make("p"),
    forgetNote: make("p"),
    forgetButton: make("button"),
    openFileButton: make("button"),
    fileInput: make("input"),
  };
  const clock = createManualClock();
  /** @type {string[]} */
  const relayed = [];
  /** @type {boolean[]} */
  const relayedAsError = [];
  /** @type {any} the options the glue gave the shelf */
  let shelfOptions = null;
  const shelf = {
    searchBox: { value: "" },
    /** @type {any[][]} */
    entries: [],
    /** @type {any[]} */
    external: [],
    /** @type {string[][]} */
    pending: [],
    queries: /** @type {string[]} */ ([]),
    selected: /** @type {number[]} */ ([]),
    /** @param {any[]} list */
    setEntries(list) {
      this.entries.push(list);
    },
    /** @param {any[]} list */
    setExternal(list) {
      this.external.push(list);
    },
    /** @param {string[]} sources */
    setPending(sources) {
      this.pending.push(sources);
    },
    /** @param {string} query */
    setQuery(query) {
      this.queries.push(query);
    },
    /** @param {number} index */
    select(index) {
      this.selected.push(index);
    },
  };
  /** @type {any} */
  const inputPanel = {
    current: () => inputPanel.loaded,
    loaded: parts.loaded?.() ?? null,
    /** @type {Array<{name: string, overrides: any, entry: any}>} */
    reads: [],
    /** @param {File} file @param {any} overrides @param {any} entry */
    async readFile(file, overrides, entry) {
      inputPanel.reads.push({ name: file.name, overrides, entry });
      inputPanel.loaded = { input: { catalogEntry: entry, sha256: "x" } };
    },
  };
  const calls = { startRun: 0, playIntro: 0, stopRun: /** @type {boolean[]} */ ([]), opened: /** @type {string[]} */ ([]), downloads: /** @type {string[][]} */ ([]) };
  const phase = { evolving: false };
  const catalog = {
    entries: [KOROBEINIKI],
    loadMore: async () => ({ entries: [KOROBEINIKI], missing: /** @type {string[]} */ ([]) }),
  };
  const glue = createCatalogGlue({
    shelfRoot: /** @type {any} */ (make("div")),
    elements: /** @type {any} */ (elements),
    inputPanel: () => inputPanel,
    isEvolving: () => phase.evolving,
    stopRun: (discard) => calls.stopRun.push(discard),
    startRun: () => void (calls.startRun += 1),
    playIntro: () => void (calls.playIntro += 1),
    fetchFn: parts.fetchFn ?? (async () => ({ ok: true, text: async () => ABC_TEXT })),
    createShelf: (_root, options) => {
      shelfOptions = options;
      return /** @type {any} */ (shelf);
    },
    loadCatalog:
      parts.loadCatalog ??
      (async (/** @type {any} */ _fetch, /** @type {any} */ onUpdate) => {
        onUpdate(catalog.entries, { collections: [], pending: [] });
        return catalog;
      }),
    songCache: createSongCache(null),
    notifyStatus: (text, isError = false) => {
      relayed.push(text);
      relayedAsError.push(isError);
    },
    loadAbcjs: async () => undefined,
    win: parts.win ?? { open: (/** @type {string} */ url) => calls.opened.push(url) },
    download: (url, name) => calls.downloads.push([url, name]),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { glue, shelf, shelfOptions: () => shelfOptions, inputPanel, calls, phase, clock, elements, relayed, relayedAsError, catalog };
}

test("the shelf gets the songs the catalog reports, and the visitor's own files go in front", async () => {
  const { glue, shelf } = setUp();
  await glue.catalogLoading;
  assert.deepEqual(shelf.entries.at(-1), [KOROBEINIKI]);

  const own = { id: "local-abc", source: "local", t: "mine.mid", route: { local: true } };
  glue.addOwnEntry(own, { name: "mine.mid", bytes: new Uint8Array([1]) });

  assert.deepEqual(shelf.entries.at(-1), [own, KOROBEINIKI]);
  assert.deepEqual(shelf.queries.at(-1), "", "the search is cleared so the new record can be seen");
  assert.deepEqual(shelf.selected.at(-1), 0);
});

test("a file opened twice gets one record, and the second time that record is selected", async () => {
  const { glue, shelf } = setUp();
  await glue.catalogLoading;
  const own = { id: "local-abc", source: "local", t: "mine.mid", route: { local: true } };
  const file = { name: "mine.mid", bytes: new Uint8Array([1]) };

  glue.addOwnEntry(own, file);
  glue.addOwnEntry(own, file);

  assert.equal(shelf.entries.at(-1)?.length, 2, "one own record and one catalog record");
  assert.deepEqual(shelf.selected, [0, 0]);
});

test("a catalog that cannot be loaded says so in the status line and as an error toast", async () => {
  const { glue, elements, relayed, relayedAsError } = setUp({
    loadCatalog: async () => {
      throw new Error("offline");
    },
  });
  await glue.catalogLoading.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(elements.status.textContent, /The catalog could not be loaded/);
  assert.equal(elements.status.classList.contains("error"), true);
  assert.match(relayed.at(-1) ?? "", /The catalog could not be loaded/);
  assert.equal(relayedAsError.at(-1), true);
});

test("Arrange on the song that is already loaded starts the run without reading the song again", async () => {
  const { shelfOptions, inputPanel, calls } = setUp({ loaded: () => ({ input: { catalogEntry: KOROBEINIKI, sha256: "x" } }) });

  await shelfOptions().onArrange(KOROBEINIKI);

  assert.equal(inputPanel.reads.length, 0);
  assert.equal(calls.startRun, 1);
});

test("Arrange on the loaded song stops a run in progress first, as a new song does", async () => {
  const { shelfOptions, calls, phase } = setUp({ loaded: () => ({ input: { catalogEntry: KOROBEINIKI, sha256: "x" } }) });
  phase.evolving = true;

  await shelfOptions().onArrange(KOROBEINIKI);

  assert.deepEqual(calls.stopRun, [true]);
  assert.equal(calls.startRun, 1);
});

test("Arrange on a song of the repository reads its file through the input panel, then starts the run", async () => {
  const { shelfOptions, inputPanel, calls, relayed } = setUp();

  await shelfOptions().onArrange(KOROBEINIKI);

  assert.equal(inputPanel.reads.length, 1);
  assert.equal(inputPanel.reads[0].entry, KOROBEINIKI, "the panel is told which record the file is");
  assert.equal(calls.startRun, 1);
  assert.equal(relayed[0], "Loading Korobeiniki…", "the visitor is told it is loading");
});

test("Preview reads the song and plays its intro, without starting a run", async () => {
  const { shelfOptions, calls } = setUp();

  await shelfOptions().onPreview(KOROBEINIKI);

  assert.equal(calls.playIntro, 1);
  assert.equal(calls.startRun, 0);
});

test("a song whose file cannot be loaded reports why as an error, and nothing runs", async () => {
  const { shelfOptions, calls, elements, relayedAsError } = setUp({ fetchFn: async () => ({ ok: false, status: 404 }) });

  await shelfOptions().onArrange(KOROBEINIKI);

  assert.equal(calls.startRun, 0);
  assert.equal(elements.status.classList.contains("error"), true);
  assert.notEqual(elements.status.textContent, "");
  assert.equal(relayedAsError.at(-1), true);
});

test("Arrange on a page of another site opens that page and starts no run; Preview opens nothing", async () => {
  const { shelfOptions, calls } = setUp();

  await shelfOptions().onPreview(PAGE_ONLY);
  assert.deepEqual(calls.opened, [], "Preview never opens a page");
  await shelfOptions().onArrange(PAGE_ONLY);

  assert.deepEqual(calls.opened, ["https://example.org/page"]);
  assert.equal(calls.startRun, 0);
  assert.equal(calls.playIntro, 0);
});

test("the Download MIDI button saves the file under the song's name and says where to find it", async () => {
  const { shelfOptions, calls, elements, relayed } = setUp();

  await shelfOptions().onDownload(AQUARELA);

  assert.deepEqual(calls.downloads, [["https://example.org/aquarela.mid", "Aquarela.mid"]]);
  assert.match(elements.status.textContent, /^Downloading Aquarela\.mid\./);
  assert.match(relayed.at(-1) ?? "", /^Downloading Aquarela\.mid\./);
});

test("Open downloaded file asks for the file, and the file the visitor chooses is claimed as that record", async () => {
  const { shelfOptions, glue, elements } = setUp({ win: {} });
  let opened = 0;
  elements.fileInput.click = () => void (opened += 1);

  await shelfOptions().onOpenDownloaded(AQUARELA);

  assert.equal(opened, 1, "a browser without the native picker opens the file input");
  assert.equal(glue.claimDownload("Aquarela (1).mid"), AQUARELA, "a copy the browser renamed is still the download");
  assert.equal(glue.claimDownload("Aquarela.mid"), null, "a claim is used up");
});

test("a chosen file that is not the download is the visitor's own", async () => {
  const { shelfOptions, glue, elements } = setUp({ win: {} });
  elements.fileInput.click = () => {};
  await shelfOptions().onOpenDownloaded(AQUARELA);

  assert.equal(glue.claimDownload("holiday.mid"), null);
});

test("a search of two letters or more asks The Session after 450 ms; one letter asks nobody", async () => {
  /** @type {string[]} */
  const asked = [];
  const { shelfOptions, shelf, clock } = setUp({
    fetchFn: async (/** @type {string} */ url) => {
      asked.push(url);
      return { ok: true, json: async () => ({ tunes: [{ id: 5, name: "Invented Jig", url: "https://thesession.org/tunes/5", type: "jig" }] }) };
    },
  });
  shelf.searchBox.value = "a";
  shelfOptions().onSearch("a");
  clock.advance(1000);
  assert.equal(asked.length, 0);

  shelf.searchBox.value = "invented";
  shelfOptions().onSearch("invented");
  clock.advance(449);
  assert.equal(asked.length, 0, "not before the typing pauses");
  clock.advance(1);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(asked.length, 1);
  assert.match(asked[0], /thesession\.org/);
  assert.equal(shelf.external.at(-1)?.[0].t, "Invented Jig");
});

test("each keystroke restarts the wait, so only the last query is asked", async () => {
  /** @type {string[]} */
  const asked = [];
  const { shelfOptions, shelf, clock } = setUp({
    fetchFn: async (/** @type {string} */ url) => {
      asked.push(url);
      return { ok: true, json: async () => ({ tunes: [] }) };
    },
  });

  for (const query of ["ba", "bal", "ball"]) {
    shelf.searchBox.value = query;
    shelfOptions().onSearch(query);
    clock.advance(300);
  }
  clock.advance(450);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(asked.length, 1);
  assert.match(asked[0], /q=ball/);
});

test("results for a query the visitor has already changed are dropped", async () => {
  /** @type {() => void} */
  let answer = () => {};
  const { shelfOptions, shelf, clock } = setUp({
    fetchFn: () =>
      new Promise((resolve) => {
        answer = () => resolve({ ok: true, json: async () => ({ tunes: [{ id: 5, name: "Late", url: "", type: "jig" }] }) });
      }),
  });
  shelf.searchBox.value = "invented";
  shelfOptions().onSearch("invented");
  clock.advance(450);
  shelf.searchBox.value = "something else";
  answer();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(shelf.external.length, 0);
});

test("a search that cannot reach The Session adds nothing and does not fail", async () => {
  const { shelfOptions, shelf, clock } = setUp({
    fetchFn: async () => {
      throw new Error("offline");
    },
  });
  shelf.searchBox.value = "invented";
  shelfOptions().onSearch("invented");
  clock.advance(450);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(shelf.external.at(-1), [], "the shelf hears of no results");
});

test("a larger catalog file that fails to load tells the visitor and stops the shelf waiting for it", async () => {
  const { shelfOptions, shelf, elements, relayedAsError } = setUp({
    loadCatalog: async (/** @type {any} */ _fetch, /** @type {any} */ onUpdate) => {
      onUpdate([KOROBEINIKI], { collections: [], pending: ["mpb"] });
      return { entries: [KOROBEINIKI], loadMore: async () => ({ entries: [KOROBEINIKI], missing: ["mpb"] }) };
    },
  });

  await shelfOptions().onNeedSongs(["mpb"]);

  assert.deepEqual(shelf.pending.at(-1), [], "mpb is no longer pending");
  assert.match(elements.status.textContent, /More songs could not be loaded/);
  assert.equal(relayedAsError.at(-1), true);
});

test("the open-file button clicks the hidden file input", () => {
  const { elements } = setUp();
  let clicked = 0;
  elements.fileInput.click = () => void (clicked += 1);

  elements.openFileButton.click();

  assert.equal(clicked, 1);
});

test("Forget downloaded songs empties the cache and hides its note", async () => {
  const { glue, elements } = setUp();
  await glue.catalogLoading;
  await new Promise((resolve) => setImmediate(resolve)); // let the start-up check of the cache finish
  elements.forgetNote.hidden = false;

  elements.forgetButton.click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(elements.forgetNote.hidden, true, "nothing is left to forget");
});
