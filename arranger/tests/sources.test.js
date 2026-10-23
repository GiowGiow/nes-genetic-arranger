// @ts-check
// Tests for core/sources.js: one catalog made of the per-source catalog files, its search and
// pages, and the routes that load a song (spec 005, stories 3 to 5, research R8). The catalog
// files here are small synthetic fixtures in tests/fixtures/catalog/, shaped like
// contracts/catalog-files.md; every title and name in them is invented.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { makeMeter } from "../src/core/meter.js";

import {
  CATALOG_FILES,
  displayTitle,
  PAGE_MESSAGE,
  PAGE_PREVIEW_MESSAGE,
  entryRequest,
  localEntry,
  externalEntry,
  fnv1a,
  isLoadedSong,
  LAZY_SOURCES,
  lazySourcesNeeded,
  loadCatalog,
  loadErrorMessage,
  mergeCatalog,
  mergeSearchResults,
  NETWORK_MESSAGE,
  openEntry,
  pageCount,
  pageOf,
  searchCatalog,
  seedOf,
  tuneText,
} from "../src/core/sources.js";
import { fixturesDir, loadAbcjs } from "./helpers.js";

/** @param {string} source */
const fixture = (source) => JSON.parse(readFileSync(join(fixturesDir, "catalog", `${source}.json`), "utf8"));
const allFiles = () => ["mpb", "examples", "nottingham", "public-domain", "pdmx"].map(fixture);

/** Names of the sites songs come from; no visitor-facing message may contain one. */
const SOURCE_SITE_NAMES = /kauffmann|thesession|the session|mutopia|bitmidi|imslp|nottingham|pdmx/i;

/**
 * A fake `fetch` that serves the fixture files and records the URLs asked for.
 *
 * @param {Record<string, {status?: number, body?: string | Uint8Array} | "reject">} routes
 *   responses by URL; a URL not listed gets a 404
 */
function fakeFetch(routes) {
  /** @type {string[]} */
  const asked = [];
  /** @param {string} url */
  const fetchFn = async (url) => {
    asked.push(url);
    const route = routes[url];
    if (route === "reject") throw new TypeError("Failed to fetch");
    const status = route?.status ?? (route ? 200 : 404);
    const body = route?.body ?? "";
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => new TextDecoder().decode(bytes),
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      arrayBuffer: async () => bytes.slice().buffer,
    };
  };
  return { fetchFn, asked };
}

const catalogRoutes = () =>
  Object.fromEntries(
    CATALOG_FILES.map(({ source, path }) => [path, { body: readFileSync(join(fixturesDir, "catalog", `${source}.json`), "utf8") }]),
  );

// --- The catalog files ------------------------------------------------------------------------

test("the catalog is made of five files, one per source, examples first", () => {
  assert.deepEqual(CATALOG_FILES, [
    { source: "examples", path: "data/catalog/examples.json" },
    { source: "mpb", path: "data/catalog/mpb.json" },
    { source: "public-domain", path: "data/catalog/public-domain.json" },
    { source: "nottingham", path: "data/catalog/nottingham.json" },
    { source: "pdmx", path: "data/catalog/pdmx.json" },
  ]);
});

test("one catalog: the examples first in their own order, then every other song from A to Z", () => {
  const titles = mergeCatalog(allFiles()).map((entry) => entry.t);
  assert.deepEqual(titles, [
    "Korobeiniki (Tetris theme)",
    "Ievan Polkka",
    "Zebra March",
    "ABACAXI AZUL",
    "ÁGUA DE LUA",
    "Another Made-up Reel",
    "BAIÃO DO TESTE",
    "CIRANDA QUEBRADA",
    "Étude for Testing",
    "The Invented Jig",
    "VALSA ANTIGA",
  ]);
});

test("the alphabetical order ignores accents and letter case, and breaks ties by id", () => {
  const file = {
    source: "mpb",
    entries: [
      { id: "b", t: "Você" },
      { id: "a", t: "voce" },
      { id: "c", t: "Vamos" },
    ],
  };
  assert.deepEqual(mergeCatalog([file]).map((entry) => entry.id), ["c", "a", "b"]);
  // The doc comment's example.
  const two = { source: "mpb", entries: [{ id: "b", t: "Você" }, { id: "c", t: "Vamos" }] };
  assert.deepEqual(mergeCatalog([two]).map((entry) => entry.id), ["c", "b"]);
});

test("examples follow their order field when the file carries one", () => {
  const examples = {
    source: "examples",
    entries: [
      { id: "aquarela", t: "Aquarela", order: 8 },
      { id: "korobeiniki", t: "Korobeiniki", order: 1 },
      { id: "ievan_polkka", t: "Ievan Polkka", order: 2 },
    ],
  };
  assert.deepEqual(mergeCatalog([examples]).map((entry) => entry.id), ["korobeiniki", "ievan_polkka", "aquarela"]);
});

test("every merged entry knows its source, even when the file states it only in the envelope", () => {
  const merged = mergeCatalog([{ source: "pdmx", entries: [{ id: "x", t: "Tune" }] }]);
  assert.equal(merged[0].source, "pdmx");
});

// --- Search and pages -------------------------------------------------------------------------

test("a query under 2 characters keeps the whole catalog in its order", () => {
  const catalog = mergeCatalog(allFiles());
  assert.equal(searchCatalog(catalog, ""), catalog);
  assert.equal(searchCatalog(catalog, " a "), catalog);
});

test("a search ranks title prefix, then title substring, then composer or performer, accents ignored", () => {
  const catalog = mergeCatalog(allFiles());
  assert.deepEqual(searchCatalog(catalog, "agua").map((entry) => entry.id), ["agua-de-lua"]);
  assert.deepEqual(searchCatalog(catalog, "invent").map((entry) => entry.id), [
    "jigs-3", // the title "The Invented Jig" contains it
    "agua-de-lua", // then composers (Ana Inventada, Invented Composer), titles A to Z
    "baiao-do-teste",
    "zebra_march",
  ]);
  assert.deepEqual(searchCatalog(catalog, "ZEBRA").map((entry) => entry.id), ["zebra_march"]);
  assert.deepEqual(searchCatalog(catalog, "duo teste").map((entry) => entry.id), ["abacaxi-azul"]);
  assert.deepEqual(searchCatalog(catalog, "teste").map((entry) => entry.id), ["baiao-do-teste", "abacaxi-azul"]);
});

test("a search returns every match, since the shelf pages through them", () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ id: `s${i}`, source: "pdmx", t: `Samba ${i}`, c: "" }));
  assert.equal(searchCatalog(many, "samba").length, 80);
});

test("a page holds perPage songs, and the last page holds the rest", () => {
  const twenty = Array.from({ length: 20 }, (_, i) => i);
  assert.deepEqual(pageOf(twenty, 0, 15), twenty.slice(0, 15));
  assert.deepEqual(pageOf(twenty, 1, 15), [15, 16, 17, 18, 19]);
  assert.deepEqual(pageOf(twenty, 2, 15), []);
  assert.equal(pageCount(20, 15), 2);
  assert.equal(pageCount(30, 15), 2);
  assert.equal(pageCount(31, 9), 4);
  assert.equal(pageCount(0, 15), 1, "an empty catalog still shows page 1 of 1");
  assert.deepEqual(pageOf([0, 1, 2, 3, 4], 1, 3), [3, 4], "the doc comment's example");
});

// --- Where songs load from --------------------------------------------------------------------

test("a repository ABC route loads from the repository, next to the app folder", () => {
  const [korobeiniki] = mergeCatalog([fixture("examples")]);
  assert.deepEqual(entryRequest(korobeiniki), {
    url: "../data/leadsheets/korobeiniki.abc",
    kind: "abc",
    tune: 0,
  });
  const jig = { id: "j", t: "J", route: { abc: "../data/catalog/abc/nottingham/jigs.abc", tune: 2 } };
  assert.deepEqual(entryRequest(jig), { url: "../data/catalog/abc/nottingham/jigs.abc", kind: "abc", tune: 2 });
});

test("a download route names the MIDI file at the catalog site, which the visitor saves and drops in", () => {
  const entry = fixture("mpb").entries[0];
  assert.deepEqual(entryRequest(entry), {
    url: "https://www.beakauffmann.com/mpb_x/som/agua-de-lua.mid",
    kind: "download",
  });
});

test("browser and link routes, and a song without a route", () => {
  assert.deepEqual(entryRequest({ id: "7", t: "T", route: { thesession: 7, setting: 1 } }), {
    url: "https://thesession.org/tunes/7?format=json",
    kind: "thesession",
    setting: 1,
  });
  assert.deepEqual(entryRequest({ id: "w", t: "W", route: { link: "https://example.org/work" } }), {
    url: "https://example.org/work",
    kind: "link",
  });
  const broken = fixture("mpb").entries.find((/** @type {any} */ entry) => entry.error);
  assert.equal(entryRequest(broken), null);
});

test("a route that only the withdrawn song server understood is not a way to load a song", () => {
  const old = { id: "a", t: "A", route: { server: "/songs/mpb/a.abc" } };
  assert.equal(entryRequest(/** @type {any} */ (old)), null);
});

test("a tune of a collection file is cut out with the file's header", () => {
  const text = "% collection header\n\nX:1\nT:One\nK:C\nC4|\n\nX:2\nT:Two\nK:G\nG4|\n\nX:3\nT:Three\nK:D\nD4|\n";
  assert.equal(tuneText(text, 1), "% collection header\n\nX:2\nT:Two\nK:G\nG4|\n\n");
  assert.equal(tuneText(text, 0), "% collection header\n\nX:1\nT:One\nK:C\nC4|\n\n");
  assert.throws(() => tuneText(text, 3), /tune 3/);
  assert.equal(tuneText("% header\nX:1\nT:One\nK:C\nC4|\n\nX:2\nT:Two\nK:G\nG4|\n", 1), "% header\nX:2\nT:Two\nK:G\nG4|\n");
  assert.equal(tuneText("T:No number\nK:C\nC4|\n", 0), "T:No number\nK:C\nC4|\n", "a file without X: is one tune");
});

// --- Loading the catalog ----------------------------------------------------------------------

test("the examples load first and show at once; the small files follow, and the big MPB file stays unread", async () => {
  const { fetchFn, asked } = fakeFetch(catalogRoutes());
  /** @type {number[]} */
  const sizes = [];
  const { entries, missing } = await loadCatalog(fetchFn, (list) => sizes.push(list.length));
  assert.equal(asked[0], "data/catalog/examples.json");
  assert.deepEqual(sizes, [3, 7], "first the 3 examples, then the 7 songs of the small files");
  assert.equal(entries[0].id, "korobeiniki");
  assert.deepEqual(missing, []);
  assert.ok(!asked.includes("data/catalog/mpb.json"), "MPB is the largest file: it is read only when needed");
  assert.deepEqual(LAZY_SOURCES, ["mpb"]);
});

test("loadMore reads a lazy file once, merges it into the catalog and tells the page", async () => {
  const { fetchFn, asked } = fakeFetch(catalogRoutes());
  /** @type {number[]} */
  const sizes = [];
  const catalog = await loadCatalog(fetchFn, (list) => sizes.push(list.length));
  const [first, second] = await Promise.all([catalog.loadMore("mpb"), catalog.loadMore("mpb")]);
  assert.equal(first.entries.length, 11, "the 4 MPB songs join the 7 others");
  assert.deepEqual(second, first, "a second ask while the file loads gets the same answer");
  assert.equal(asked.filter((url) => url === "data/catalog/mpb.json").length, 1, "one request for the file");
  await catalog.loadMore("mpb");
  assert.equal(asked.filter((url) => url === "data/catalog/mpb.json").length, 1, "and none once it is loaded");
  assert.deepEqual(sizes, [3, 7, 11], "the page hears about the new songs once");
  assert.equal(first.entries.filter((entry) => entry.source === "mpb").length, 4);
});

test("a catalog file that is missing or unreachable is skipped, and the others still load", async () => {
  const routes = { ...catalogRoutes(), "data/catalog/pdmx.json": { status: 404 }, "data/catalog/mpb.json": /** @type {const} */ ("reject") };
  const { fetchFn } = fakeFetch(routes);
  const catalog = await loadCatalog(fetchFn);
  assert.deepEqual(catalog.missing, ["pdmx"]);
  assert.equal(catalog.entries.length, 6);
  const more = await catalog.loadMore("mpb");
  assert.deepEqual(more.missing, ["mpb", "pdmx"], "listed in the catalog's order");
  assert.equal(more.entries.length, 6, "the songs that did load stay");
});

test("a lazy file that failed is read again the next time it is asked for", async () => {
  /** @type {Record<string, any>} */
  const routes = { ...catalogRoutes(), "data/catalog/mpb.json": "reject" };
  const { fetchFn, asked } = fakeFetch(routes);
  const catalog = await loadCatalog(fetchFn);
  await catalog.loadMore("mpb");
  Object.assign(routes, catalogRoutes());
  const again = await catalog.loadMore("mpb");
  assert.equal(asked.filter((url) => url === "data/catalog/mpb.json").length, 2);
  assert.equal(again.entries.length, 11);
  assert.deepEqual(again.missing, []);
});

test("loadMore of a source that is not lazy or not in the catalog changes nothing", async () => {
  const { fetchFn, asked } = fakeFetch(catalogRoutes());
  const catalog = await loadCatalog(fetchFn);
  const before = asked.length;
  const more = await catalog.loadMore("examples");
  await catalog.loadMore("nowhere");
  assert.equal(asked.length, before);
  assert.equal(more.entries.length, 7);
});

// --- When the lazy files are needed ------------------------------------------------------------

test("the MPB file is needed when the visitor opens the MPB playlist", () => {
  assert.deepEqual(lazySourcesNeeded({ playlistId: "mpb", searching: false, cachedKeys: [] }), ["mpb"]);
  assert.deepEqual(lazySourcesNeeded({ playlistId: "popular", searching: false, cachedKeys: [] }), []);
  assert.deepEqual(lazySourcesNeeded({ playlistId: "folk", searching: false, cachedKeys: [] }), []);
});

test("a search looks through every song, so it needs every lazy file", () => {
  assert.deepEqual(lazySourcesNeeded({ playlistId: "popular", searching: true, cachedKeys: [] }), ["mpb"]);
});

test("a song downloaded before (its key is in the cache) needs its file, so it can show in Popular", () => {
  assert.deepEqual(lazySourcesNeeded({ playlistId: "popular", searching: false, cachedKeys: ["mpb:agua-de-lua"] }), ["mpb"]);
  assert.deepEqual(lazySourcesNeeded({ playlistId: "popular", searching: false, cachedKeys: ["local:abc"] }), []);
});

test("the needed sources are listed once", () => {
  assert.deepEqual(lazySourcesNeeded({ playlistId: "mpb", searching: true, cachedKeys: ["mpb:a", "mpb:b"] }), ["mpb"]);
});

// --- Opening a song ---------------------------------------------------------------------------

test("opening a repository song reads its ABC, and only its tune of the collection", async () => {
  const collection = "% header\nX:1\nT:First\nK:C\nC4|\n\nX:2\nT:Second\nK:G\nG4|\n";
  const { fetchFn } = fakeFetch({ "../data/catalog/abc/nottingham/jigs.abc": { body: collection } });
  const entry = { id: "jigs-2", t: "Second", route: { abc: "data/catalog/abc/nottingham/jigs.abc", tune: 1 } };
  const opened = await openEntry(entry, { fetchFn });
  assert.deepEqual(opened, { kind: "abc", name: "Second.abc", text: "% header\nX:2\nT:Second\nK:G\nG4|\n" });
});

test("an MPB song opens by its download route: the page saves the MIDI file and the visitor drops it in", async () => {
  const entry = fixture("mpb").entries[0];
  const { fetchFn, asked } = fakeFetch({});
  const opened = await openEntry(entry, { fetchFn });
  assert.deepEqual(opened, {
    kind: "link",
    name: "Água de Lua.mid",
    url: "https://www.beakauffmann.com/mpb_x/som/agua-de-lua.mid",
    byHand: true,
  });
  assert.equal(asked.length, 0, "the page cannot read the site's file, so it asks for nothing");
  assert.match(PAGE_MESSAGE, /MIDI file is downloading/);
  assert.match(PAGE_PREVIEW_MESSAGE, /choose Arrange to download it/);
});

test("a download route takes the file name from the song's title, without characters that file names refuse", async () => {
  const entry = { id: "x", t: "A/B: tune", route: { download: "https://example.org/x.mid" } };
  const opened = await openEntry(entry, { fetchFn: fakeFetch({}).fetchFn });
  assert.equal(opened.name, "A-B- tune.mid");
});

test("entries from files in the repository need no network beyond their own file", async () => {
  const korobeiniki = fixture("examples").entries[0];
  const { fetchFn, asked } = fakeFetch({ ["../data/leadsheets/korobeiniki.abc"]: { body: "X:1\nT:K\nK:Am\nA|\n" } });
  const opened = await openEntry(korobeiniki, { fetchFn });
  assert.equal(opened.kind, "abc");
  assert.deepEqual(asked, ["../data/leadsheets/korobeiniki.abc"]);
});

test("a file that cannot be fetched becomes a plain sentence, without the site's own words", async () => {
  const entry = { id: "r", t: "R", route: { abc: "data/leadsheets/r.abc" } };
  await assert.rejects(openEntry(entry, { fetchFn: fakeFetch({ "../data/leadsheets/r.abc": "reject" }).fetchFn }), {
    message: NETWORK_MESSAGE,
  });
  for (const [status, expected] of /** @type {Array<[number, RegExp]>} */ ([
    [404, /not available/],
    [429, /Wait a minute/],
    [500, /HTTP 500/],
  ])) {
    const { fetchFn } = fakeFetch({ "../data/leadsheets/r.abc": { status, body: '{"error": "upstream says something"}' } });
    await assert.rejects(openEntry(entry, { fetchFn }), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, expected);
      assert.equal(error.message, loadErrorMessage(status));
      assert.doesNotMatch(error.message, /upstream says/, "the app writes its own sentence");
      return true;
    });
  }
});

test("the doc comment's load messages", () => {
  assert.equal(loadErrorMessage(404), "This song is not available.");
  assert.equal(loadErrorMessage(500), "The song could not be loaded (HTTP 500).");
});

test("no load message names a source site", () => {
  for (const status of [400, 404, 429, 500, 502, 503]) {
    assert.doesNotMatch(loadErrorMessage(status), SOURCE_SITE_NAMES);
    assert.match(loadErrorMessage(status), /\.$/, "a full sentence");
  }
  assert.doesNotMatch(NETWORK_MESSAGE, SOURCE_SITE_NAMES);
});

test("a link-only song is not fetched: the caller opens its page", async () => {
  const { fetchFn, asked } = fakeFetch({});
  const entry = { id: "w", t: "Work", route: { link: "https://example.org/work" } };
  assert.deepEqual(await openEntry(entry, { fetchFn }), { kind: "link", name: "Work", url: "https://example.org/work" });
  assert.equal(asked.length, 0);
});

test("a song without a route cannot be opened, and says so", async () => {
  const broken = fixture("mpb").entries.find((/** @type {any} */ entry) => entry.error);
  const { fetchFn, asked } = fakeFetch({});
  await assert.rejects(openEntry(broken, { fetchFn }), /cannot be arranged/);
  assert.equal(asked.length, 0);
});

test("a tune from the folk tune site opens as MIDI made in the browser (synthetic tune)", async () => {
  // Invented tune, shaped like the site's tune JSON: never real data (constitution 2.0.0).
  const tune = { id: 90001, name: "The Made-up Polka", type: "polka", settings: [{ id: 1, key: "Gmajor", abc: '|:"G"GA Bc|dB GB|"D"A2 F2|D4:|' }] };
  const { fetchFn } = fakeFetch({ "https://thesession.org/tunes/90001?format=json": { body: JSON.stringify(tune) } });
  const entry = { id: "90001", source: "thesession", t: "The Made-up Polka", route: { thesession: 90001, setting: 0 } };
  const opened = await openEntry(entry, { fetchFn, abcjs: loadAbcjs() });
  assert.equal(opened.kind, "midi");
  assert.equal(opened.name, "The Made-up Polka.mid");
  assert.equal(new TextDecoder().decode(opened.bytes?.subarray(0, 4)), "MThd");
});

test("an all-capitals title reads in title case, with the small Portuguese words in lowercase", () => {
  assert.equal(displayTitle("10 MINUTOS LONGE DE VOCÊ"), "10 Minutos Longe de Você");
  assert.equal(displayTitle("O QUE É O AMOR"), "O Que É o Amor");
  assert.equal(displayTitle('"VAMO" EMBOLANDO'), '"Vamo" Embolando');
  assert.equal(displayTitle("MADE-UP (AO VIVO)"), "Made-up (Ao Vivo)");
  assert.equal(displayTitle("Ievan Polkka"), "Ievan Polkka", "a title with lowercase letters stays as written");
  assert.equal(displayTitle("1 X 0"), "1 X 0");
});

// --- External search results ------------------------------------------------------------------

test("an external search result becomes a catalog entry with a stable sprite seed", () => {
  const result = {
    source: "thesession",
    id: "90123",
    title: "Invented Polka",
    composer: "",
    license: "CC0",
    format: "abc",
    page: "https://example.org/90123",
    open: "https://example.org/90123?format=json",
  };
  const entry = externalEntry(result);
  assert.deepEqual(entry, {
    id: "90123",
    source: "thesession",
    t: "Invented Polka",
    c: "",
    license: "CC0",
    seed: seedOf("thesession", "90123"),
    route: { thesession: "90123" },
  });
  assert.equal(externalEntry({ ...result, error: "its type does not fix a meter" }).error, "its type does not fix a meter");
  assert.equal(externalEntry({ ...result, error: "x" }).route, undefined, "a result with an error has no route");
});

test("a sprite seed of an external song is the FNV-1a hash of source:id, a stable 32-bit number", () => {
  // Published FNV-1a 32-bit test vectors.
  assert.equal(fnv1a(""), 0x811c9dc5);
  assert.equal(fnv1a("a"), 0xe40c292c);
  assert.equal(fnv1a("foobar"), 0xbf9cf968);
  assert.equal(seedOf("web", "123"), fnv1a("web:123"));
  assert.notEqual(seedOf("web", "123"), seedOf("web", "124"));
});

test("external results come after the local ones, without songs listed twice", () => {
  const local = mergeCatalog([fixture("nottingham")]);
  const external = [
    { source: "nottingham", id: "jigs-3", title: "The Invented Jig", composer: "Trad.", license: "GPL-3.0", format: "abc", page: "", open: "/x" },
    { source: "thesession", id: "5", title: "Invented Five", composer: "", license: "CC0", format: "abc", page: "", open: "/y" },
    { source: "thesession", id: "5", title: "Invented Five", composer: "", license: "CC0", format: "abc", page: "", open: "/y" },
  ];
  const merged = mergeSearchResults(local, external);
  assert.deepEqual(merged.map((entry) => `${entry.source}:${entry.id}`), ["nottingham:reels-1", "nottingham:jigs-3", "thesession:5"]);
  assert.equal(merged[0], local[0], "local entries stay as they are");
});

test("a file the visitor opens becomes a record of its own, named by the song or the file", () => {
  const sha256 = "ab12cd34ef56".padEnd(64, "0");
  const bar = { meter: makeMeter(3, 4) };
  const leadSheet = { title: "My Tune", key: "e- minor", tempoBpm: 96, bars: [bar, bar, bar, bar] };
  const entry = localEntry({ name: "my_tune.mid", sha256, leadSheet: /** @type {any} */ (leadSheet) });
  assert.equal(entry.id, "local-ab12cd34ef56");
  assert.equal(entry.source, "local");
  assert.equal(entry.t, "My Tune");
  assert.equal(entry.c, "Your file");
  assert.deepEqual(entry.route, { local: true });
  assert.equal(entry.seed, 0xab12cd34, "the sprite follows the file's hash, so the same file looks the same");
  assert.deepEqual(entry.facts, { key: "e- minor", tempo_bpm: 96, meter: "3/4", n_bars: 4 });
  const untitled = localEntry({ name: "my_tune.final.mid", sha256, leadSheet: /** @type {any} */ ({ ...leadSheet, title: "" }) });
  assert.equal(untitled.t, "my_tune.final", "no title: the file name without its extension");
});

// --- The song that is already loaded ----------------------------------------------------------

test("a record is the loaded song when the input came from it, so arranging it again keeps the visitor's choices", () => {
  const sha256 = "ab12cd34ef56".padEnd(64, "0");
  const leadSheet = /** @type {any} */ ({ title: "My Tune", key: "", tempoBpm: 96, bars: [] });
  const own = localEntry({ name: "my_tune.mid", sha256, leadSheet });

  // A file the visitor just dropped has no record behind it yet; the record is made from its hash.
  assert.equal(isLoadedSong(own, { sha256, catalogEntry: null }), true);
  // A file read again from its record carries that record.
  assert.equal(isLoadedSong(own, { sha256, catalogEntry: own }), true);
  // A shelf song carries its own record, found by source and id.
  const [shelfSong] = fixture("nottingham").entries;
  assert.equal(isLoadedSong(shelfSong, { sha256: "0".repeat(64), catalogEntry: shelfSong }), true);
  assert.equal(isLoadedSong({ ...shelfSong }, { sha256: "0".repeat(64), catalogEntry: shelfSong }), true, "the same song, not the same object");
});

test("a record is not the loaded song when the input is another file or another record", () => {
  const sha256 = "ab12cd34ef56".padEnd(64, "0");
  const leadSheet = /** @type {any} */ ({ title: "My Tune", key: "", tempoBpm: 96, bars: [] });
  const own = localEntry({ name: "my_tune.mid", sha256, leadSheet });
  const [shelfSong, otherSong] = fixture("nottingham").entries;

  assert.equal(isLoadedSong(own, { sha256: "99".repeat(32), catalogEntry: null }), false, "another file");
  assert.equal(isLoadedSong(shelfSong, { sha256, catalogEntry: null }), false, "a file of the visitor is not a shelf song");
  assert.equal(isLoadedSong(shelfSong, { sha256, catalogEntry: otherSong }), false, "another shelf song");
  assert.equal(isLoadedSong({ ...shelfSong, source: "pdmx" }, { sha256, catalogEntry: shelfSong }), false, "the same id in another source");
  assert.equal(isLoadedSong(shelfSong, null), false, "nothing is loaded");
});
