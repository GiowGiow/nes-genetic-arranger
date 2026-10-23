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

/** A song of the MPB site, whose file the Worker can bring. */
const SAMBA = {
  id: "samba",
  source: "mpb",
  t: "Samba",
  c: "",
  u: "https://www.beakauffmann.com/mpb_v/samba.html",
  route: { download: "https://www.beakauffmann.com/mpb_v/som/samba.mid" },
  facts: { sha256: "a".repeat(64), overrides: { max_generations: 4000 } },
};

/** The Worker used by the tests. */
const WORKER = "https://fetcher.test";

/** A tiny MIDI file, as the Worker sends it. */
const MIDI = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, 0, 96]);

/** A record that is a page of another site, with no file to read. */
const PAGE_ONLY = { id: "page", source: "elsewhere", t: "A page", c: "", route: { link: "https://example.org/page" } };

/** A tiny ABC tune, as the repository serves it. */
const ABC_TEXT = "X:1\nT:Korobeiniki\nM:4/4\nL:1/4\nK:Am\nA B c d|\n";

/**
 * A glue on fakes, with a record of everything it does to them.
 *
 * @param {Record<string, any>} [parts] `fetchFn`, `loadCatalog`, `win`, `loaded`, and any option of the glue to override
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
  /** @type {Array<{text: string, options: any}>} */
  const toasts = [];
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
    setExternal(list, status) {
      this.external.push(list);
      this.statuses.push(status);
    },
    statuses: /** @type {any[]} */ ([]),
    /** @param {string[]} sources */
    setPending(sources) {
      this.pending.push(sources);
    },
    progress: /** @type {Array<[string, any]>} */ ([]),
    /** @param {string} source @param {any} reading */
    setProgress(source, reading) {
      this.progress.push([source, reading]);
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
    fetcherUrl: parts.fetcherUrl === undefined ? WORKER : parts.fetcherUrl,
    now: parts.now,
    onlineSources: parts.onlineSources,
    isOnline: parts.isOnline ?? (() => true),
    toast: (text, options) => void toasts.push({ text, options }),
    idle: parts.idle ?? (() => {}),
    connection: parts.connection ?? {},
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
    songCache: parts.songCache ?? createSongCache(null),
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
  return { glue, shelf, shelfOptions: () => shelfOptions, inputPanel, calls, phase, clock, elements, relayed, relayedAsError, catalog, toasts };
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

/** A fetch that answers The Session and the Worker's searches with one result each, and BitMidi with two. */
function searchFetch(asked = /** @type {string[]} */ ([])) {
  return async (/** @type {string} */ url) => {
    asked.push(url);
    if (url.startsWith("https://thesession.org/")) {
      return { ok: true, json: async () => ({ tunes: [{ id: 5, name: "Invented Jig", url: "https://thesession.org/tunes/5", type: "jig" }] }) };
    }
    if (url.startsWith("https://bitmidi.com/api/")) {
      return { ok: true, json: async () => ({ result: { results: [{ id: 7, name: "invented-band-song.mid", url: "/invented-band-song-mid" }] } }) };
    }
    return { ok: true, json: async () => ({ results: [] }) };
  };
}

test("a search of two letters or more asks the online sources after 300 ms; one letter asks nobody", async () => {
  /** @type {string[]} */
  const asked = [];
  const { shelfOptions, shelf, clock } = setUp({ fetchFn: searchFetch(asked) });
  shelf.searchBox.value = "a";
  shelfOptions().onSearch("a");
  clock.advance(1000);
  assert.equal(asked.length, 0);

  shelf.searchBox.value = "invented";
  shelfOptions().onSearch("invented");
  clock.advance(299);
  assert.equal(asked.length, 0, "not before the typing pauses");
  clock.advance(1);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(asked.length, 4, "The Session, BitMidi, midis101.com and Mutopia, once each");
  assert.ok(asked.some((url) => url.startsWith("https://thesession.org/")));
  assert.ok(asked.some((url) => url.startsWith("https://bitmidi.com/api/midi/search")));
  assert.ok(asked.includes(`${WORKER}/search/midis101?q=invented`));
  assert.ok(asked.includes(`${WORKER}/search/mutopia?q=invented`));
  const last = shelf.external.at(-1) ?? [];
  assert.deepEqual(last.map((/** @type {any} */ entry) => [entry.source, entry.t]), [["thesession", "Invented Jig"], ["bitmidi", "Invented Band Song"], ["imslp", 'Search "invented" on IMSLP']]);
  assert.equal(shelf.statuses.at(-1).searching, false);
});

test("the shelf hears where the search stands while the sources answer", async () => {
  const { shelfOptions, shelf, clock } = setUp({ fetchFn: searchFetch() });
  shelf.searchBox.value = "invented";
  shelfOptions().onSearch("invented");
  clock.advance(300);
  assert.deepEqual(shelf.statuses.at(-1).pending, ["The Session", "BitMidi", "midis101.com", "Mutopia Project"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(shelf.statuses.at(-1).pending, []);
});

test("a result of BitMidi becomes a record that opens through the Worker", async () => {
  const { shelfOptions, shelf, clock } = setUp({ fetchFn: searchFetch() });
  shelf.searchBox.value = "invented";
  shelfOptions().onSearch("invented");
  clock.advance(300);
  await new Promise((resolve) => setImmediate(resolve));
  const record = (shelf.external.at(-1) ?? []).find((/** @type {any} */ entry) => entry.source === "bitmidi");
  assert.deepEqual(record.route, { download: "https://bitmidi.com/uploads/7.mid" });
  assert.equal(shelfOptions().isOneClick(record), true);
});

test("each keystroke restarts the wait, so only the last query is asked", async () => {
  /** @type {string[]} */
  const asked = [];
  const { shelfOptions, shelf, clock } = setUp({ fetchFn: searchFetch(asked) });

  for (const query of ["ba", "bal", "ball"]) {
    shelf.searchBox.value = query;
    shelfOptions().onSearch(query);
    clock.advance(200);
  }
  clock.advance(300);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(asked.length, 4);
  assert.ok(asked.every((url) => /q=ball/.test(url)));
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
  clock.advance(300);
  shelf.searchBox.value = "something else";
  answer();
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(shelf.external.every((/** @type {any[]} */ list) => list.every((entry) => entry.t !== "Late")), "nothing from the old query's answer reached the shelf");
});

test("when every source fails nothing is added; the shelf is told, and a toast offers Retry", async () => {
  const { shelfOptions, shelf, clock, toasts } = setUp({
    fetchFn: async () => {
      throw new Error("offline");
    },
  });
  shelf.searchBox.value = "invented";
  shelfOptions().onSearch("invented");
  clock.advance(300);
  await new Promise((resolve) => setImmediate(resolve));

  const status = shelf.statuses.at(-1);
  assert.equal(status.searching, false);
  assert.equal(status.failed.length, 4, "IMSLP needs no request, so it cannot fail");
  assert.equal(shelf.external.at(-1)?.length, 1, "only the IMSLP link");
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].text, /The Session, BitMidi, midis101\.com, Mutopia Project could not be reached/);
  assert.equal(toasts[0].options.kind, "error");
  assert.equal(toasts[0].options.action.label, "Retry");
});

test("Retry in the toast asks again only the sources that failed", async () => {
  let down = true;
  /** @type {string[]} */
  const asked = [];
  const { shelfOptions, shelf, clock, toasts } = setUp({
    fetchFn: async (/** @type {string} */ url) => {
      asked.push(url);
      if (down && url.startsWith("https://bitmidi.com")) throw new Error("down");
      return { ok: true, json: async () => ({ tunes: [], results: [], result: { results: [] } }) };
    },
  });
  shelf.searchBox.value = "invented";
  shelfOptions().onSearch("invented");
  clock.advance(300);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(toasts.length, 1);
  down = false;
  asked.length = 0;
  toasts[0].options.action.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asked.length, 1, "only BitMidi");
  assert.equal(shelf.statuses.at(-1).failed.length, 0);
});

test("offline, the search asks nobody and says so in a toast", async () => {
  /** @type {string[]} */
  const asked = [];
  const { shelfOptions, shelf, clock, toasts } = setUp({ fetchFn: searchFetch(asked), isOnline: () => false });
  shelf.searchBox.value = "invented";
  shelfOptions().onSearch("invented");
  clock.advance(300);
  assert.equal(asked.length, 0);
  assert.equal(shelf.statuses.at(-1).offline, true);
  assert.match(toasts[0].text, /offline/i);
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

// --- Songs on other sites: the Worker ---------------------------------------------------------------

/** A fetch that answers the Worker's file requests with `answer`, and everything else with the ABC tune. */
function workerFetch(answer, asked = /** @type {string[]} */ ([])) {
  return async (/** @type {string} */ url) => {
    asked.push(url);
    if (url.startsWith(`${WORKER}/midi`)) return answer();
    return { ok: true, text: async () => ABC_TEXT };
  };
}
const midiAnswer = () => new Response(MIDI, { status: 200 });

test("a song on another site opens in one click: the Worker brings its file and the run starts", async () => {
  /** @type {string[]} */
  const asked = [];
  const { shelfOptions, inputPanel, calls, relayed } = setUp({ fetchFn: workerFetch(midiAnswer, asked) });

  await shelfOptions().onArrange(SAMBA);

  assert.deepEqual(asked, [`${WORKER}/midi?url=${encodeURIComponent(SAMBA.route.download)}`]);
  assert.equal(inputPanel.reads.length, 1);
  assert.equal(inputPanel.reads[0].name, "Samba.mid");
  assert.deepEqual(inputPanel.reads[0].overrides, { max_generations: 4000 }, "the record's own limits apply");
  assert.equal(inputPanel.reads[0].entry, SAMBA);
  assert.equal(calls.startRun, 1);
  assert.equal(calls.downloads.length, 0, "no download by hand");
  assert.equal(relayed[0], "Loading Samba…");
});

test("Preview of a song on another site also goes through the Worker and plays the intro", async () => {
  const { shelfOptions, calls } = setUp({ fetchFn: workerFetch(midiAnswer) });
  await shelfOptions().onPreview(SAMBA);
  assert.equal(calls.playIntro, 1);
  assert.equal(calls.startRun, 0);
});

test("such a song is one click while the Worker works, and not once the Worker is off", () => {
  const { shelfOptions } = setUp();
  assert.equal(shelfOptions().isOneClick(SAMBA), true);
  assert.equal(shelfOptions().isOneClick(AQUARELA), false, "a site the Worker does not serve");
  const without = setUp({ fetcherUrl: null });
  assert.equal(without.shelfOptions().isOneClick(SAMBA), false, "no Worker, no one click");
});

test("when the Worker cannot be reached the song falls back to the download flow, with a toast that says why", async () => {
  const { shelfOptions, calls, relayed, relayedAsError, shelf } = setUp({
    fetchFn: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  const updates = shelf.entries.length;

  const opened = await shelfOptions().onArrange(SAMBA);

  assert.equal(opened, undefined);
  assert.equal(calls.startRun, 0);
  assert.match(relayed.at(-1) ?? "", /^Samba could not be fetched automatically\. .*Download the file and open it by hand\.$/);
  assert.equal(relayedAsError.at(-1), true);
  assert.equal(shelfOptions().isOneClick(SAMBA), false, "the panel now offers Download MIDI");
  assert.ok(shelf.entries.length > updates, "the shelf is told, to redraw the panel");
});

test("a song the source no longer has fails alone: other songs still go through the Worker", async () => {
  const { shelfOptions } = setUp({ fetchFn: workerFetch(() => new Response("{}", { status: 404 })) });
  const other = { ...SAMBA, id: "other", t: "Other", route: { download: "https://www.beakauffmann.com/mpb_v/som/other.mid" } };
  await shelfOptions().onArrange(SAMBA);
  assert.equal(shelfOptions().isOneClick(SAMBA), false);
  assert.equal(shelfOptions().isOneClick(other), true);
});

test("a Worker that is down or overloaded makes every such song a download for a minute, then it is tried again", async () => {
  let now = 0;
  const { shelfOptions } = setUp({ fetchFn: workerFetch(() => new Response("{}", { status: 429 })), now: () => now });
  const other = { ...SAMBA, id: "other", t: "Other", route: { download: "https://bitmidi.com/uploads/9.mid" } };
  await shelfOptions().onArrange(SAMBA);
  assert.equal(shelfOptions().isOneClick(other), false);
  now = 59_000;
  assert.equal(shelfOptions().isOneClick(other), false);
  now = 61_000;
  assert.equal(shelfOptions().isOneClick(other), true);
});

/** A cache over a map, standing in for IndexedDB. */
function mapCache() {
  const store = new Map();
  return createSongCache({
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => void store.set(key, value),
    keys: async () => [...store.keys()],
    clear: async () => store.clear(),
  });
}

/** @param {Uint8Array} bytes */
const sha256 = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");

test("a song kept in the browser opens without asking the Worker", async () => {
  /** @type {string[]} */
  const asked = [];
  const songCache = mapCache();
  const hash = await sha256(MIDI);
  const kept = { ...SAMBA, facts: { ...SAMBA.facts, sha256: hash } };
  await songCache.remember(kept, MIDI, hash);
  const { shelfOptions, inputPanel, calls } = setUp({ fetchFn: workerFetch(midiAnswer, asked), songCache });

  await shelfOptions().onArrange(kept);

  assert.deepEqual(asked, []);
  assert.equal(inputPanel.reads.length, 1);
  assert.equal(calls.startRun, 1);
});

test("a file the Worker brought is kept for next time, and the visitor is told", async () => {
  const songCache = mapCache();
  const { glue, toasts } = setUp({ songCache });
  const hash = await sha256(MIDI);
  const song = { ...SAMBA, facts: { ...SAMBA.facts, sha256: hash } };

  await glue.rememberDownload({ input: { catalogEntry: song, bytes: MIDI, sha256: hash } });

  assert.equal(songCache.has(song), true);
  assert.match(toasts.at(-1)?.text ?? "", /Saved in this browser/);
});

test("a song found by a search, with no recorded hash, is kept as first downloaded", async () => {
  const songCache = mapCache();
  const { glue } = setUp({ songCache });
  const found = { id: "7", source: "bitmidi", t: "Found", route: { download: "https://bitmidi.com/uploads/7.mid" } };

  await glue.rememberDownload({ input: { catalogEntry: found, bytes: MIDI, sha256: "f".repeat(64) } });

  assert.equal(songCache.has(found), true);
});

// --- Loading the big file -------------------------------------------------------------------------

test("the share of a big file that has arrived goes to the shelf, and ends when the file is in", async () => {
  const { shelfOptions, shelf } = setUp({
    loadCatalog: async (/** @type {any} */ _fetch, /** @type {any} */ onUpdate, /** @type {any} */ onProgress) => {
      onUpdate([KOROBEINIKI], { collections: [], pending: ["mpb"] });
      return {
        entries: [KOROBEINIKI],
        loadMore: async () => {
          onProgress("mpb", { loaded: 50, total: 100 });
          return { entries: [KOROBEINIKI], missing: [] };
        },
      };
    },
  });

  await shelfOptions().onNeedSongs(["mpb"]);

  assert.deepEqual(shelf.progress, [["mpb", { loaded: 50, total: 100 }], ["mpb", null]]);
});

/** A glue whose catalog has MPB pending, and a record of what is asked of `loadMore`. */
function prefetchSetUp(extra = {}) {
  /** @type {string[]} */
  const loaded = [];
  /** @type {Array<() => void>} */
  const idleTasks = [];
  const made = setUp({
    idle: (/** @type {() => void} */ run) => idleTasks.push(run),
    loadCatalog: async (/** @type {any} */ _fetch, /** @type {any} */ onUpdate) => {
      onUpdate([KOROBEINIKI], { collections: [], pending: ["mpb"] });
      return {
        entries: [KOROBEINIKI],
        loadMore: async (/** @type {string} */ source) => {
          loaded.push(source);
          return { entries: [KOROBEINIKI], missing: [] };
        },
      };
    },
    ...extra,
  });
  return { ...made, loaded, idleTasks };
}

test("when the browser is idle the big file is read ahead, so the first search is instant", async () => {
  const { glue, loaded, idleTasks } = prefetchSetUp();
  await glue.catalogLoading;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(loaded, [], "not before the browser is idle");
  assert.equal(idleTasks.length, 1);
  idleTasks[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(loaded, ["mpb"]);
});

test("the big file is not read ahead on a connection that saves data or is slow", async () => {
  for (const connection of [{ saveData: true }, { effectiveType: "3g" }, { type: "cellular" }]) {
    const { glue, loaded, idleTasks } = prefetchSetUp({ connection });
    await glue.catalogLoading;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(idleTasks.length, 0, JSON.stringify(connection));
    assert.deepEqual(loaded, []);
  }
});
