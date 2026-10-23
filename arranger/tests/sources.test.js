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
  displayTitle,
  PAGE_MESSAGE,
  PAGE_PREVIEW_MESSAGE,
  entryRequest,
  FALLBACK_COLLECTIONS,
  localEntry,
  externalEntry,
  fnv1a,
  isLoadedSong,
  lazySourcesNeeded,
  licenseNotice,
  loadCatalog,
  loadErrorMessage,
  mergeCatalog,
  mergeSearchResults,
  midiDownload,
  NETWORK_MESSAGE,
  openEntry,
  pageCount,
  pageOf,
  parseRegistry,
  playlistIdOf,
  REGISTRY_PATH,
  searchCatalog,
  seedOf,
  shouldPrefetch,
  tuneText,
  warmSearchIndex,
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
    FALLBACK_COLLECTIONS.map(({ id, path }) => [path, { body: readFileSync(join(fixturesDir, "catalog", `${id}.json`), "utf8") }]),
  );

// --- The catalog files ------------------------------------------------------------------------

test("without a registry the catalog is made of the five built-in collections, examples first", () => {
  assert.deepEqual(
    FALLBACK_COLLECTIONS.map(({ id, path, name, kind, lazy, order, enabled }) => ({ id, path, name, kind, lazy, order, enabled })),
    [
      { id: "examples", path: "data/catalog/examples.json", name: "Examples", kind: "abc", lazy: false, order: 10, enabled: true },
      { id: "mpb", path: "data/catalog/mpb.json", name: "MPB", kind: "remote", lazy: true, order: 20, enabled: true },
      { id: "public-domain", path: "data/catalog/public-domain.json", name: "Choro & public domain", kind: "abc", lazy: false, order: 30, enabled: true },
      { id: "nottingham", path: "data/catalog/nottingham.json", name: "Folk tunes", kind: "abc", lazy: false, order: 40, enabled: true },
      { id: "pdmx", path: "data/catalog/pdmx.json", name: "Classical & standards", kind: "abc", lazy: false, order: 50, enabled: true },
    ],
  );
});

test("the built-in list is the one the committed registry holds, so the app and the command line agree", () => {
  const registry = JSON.parse(readFileSync(join(fixturesDir, "..", "..", "data", "catalog", "collections.json"), "utf8"));
  const committed = parseRegistry(registry) ?? [];
  for (const builtin of FALLBACK_COLLECTIONS) {
    const found = committed.find((record) => record.id === builtin.id);
    assert.ok(found, `the registry lists ${builtin.id}`);
    assert.deepEqual(
      { id: found.id, path: found.path, name: found.name, kind: found.kind, lazy: found.lazy, order: found.order, enabled: found.enabled },
      { id: builtin.id, path: builtin.path, name: builtin.name, kind: builtin.kind, lazy: builtin.lazy, order: builtin.order, enabled: builtin.enabled },
    );
  }
});

// --- The registry ------------------------------------------------------------------------------

const records = (/** @type {object[]} */ list) => ({ collections: list });
const sample = (/** @type {string} */ id, /** @type {object} */ extra = {}) => ({
  id,
  path: `data/catalog/${id}.json`,
  name: id.toUpperCase(),
  kind: "abc",
  lazy: false,
  order: 50,
  enabled: true,
  ...extra,
});

test("the registry lists the collections in the order of their numbers, then their names", () => {
  const parsed = parseRegistry(records([sample("c", { order: 30 }), sample("b", { order: 10, name: "Beta" }), sample("a", { order: 10, name: "Alpha" })]));
  assert.deepEqual(parsed?.map((record) => record.id), ["a", "b", "c"]);
});

test("a record missing its optional fields gets the defaults: abc, not lazy, enabled, after the others", () => {
  const [record] = parseRegistry(records([{ id: "x", path: "data/catalog/x.json", name: "X" }])) ?? [];
  assert.deepEqual(
    { kind: record.kind, lazy: record.lazy, enabled: record.enabled, order: record.order },
    { kind: "abc", lazy: false, enabled: true, order: 1000 },
  );
});

test("the registry keeps the extras of a local MIDI collection: its sort, its description and its folder", () => {
  const [record] = parseRegistry(records([sample("mine", { kind: "local-midi", default_sort: "title", description: "My tunes", dir: "songs/mine" })])) ?? [];
  assert.deepEqual([record.kind, record.default_sort, record.description], ["local-midi", "title", "My tunes"]);
});

test("a record that cannot be used is skipped, and the others still count", () => {
  const parsed = parseRegistry(
    records([
      sample("good"),
      { id: "no-path", name: "No path" },
      { id: "bad-path", path: "../../etc/passwd", name: "Bad" },
      { id: "absolute", path: "/data/catalog/x.json", name: "Absolute" },
      { id: "remote", path: "https://example.org/x.json", name: "Remote" },
      sample("good"),
      sample("wrong-kind", { kind: "weird" }),
      "not an object",
    ]),
  );
  assert.deepEqual(parsed?.map((record) => record.id), ["good", "wrong-kind"]);
  assert.equal(parsed?.[1].kind, "abc", "an unknown kind reads as abc");
});

test("a registry that is not a registry, or lists nothing usable, is null so the built-in list applies", () => {
  for (const bad of [null, {}, [], { collections: "x" }, { collections: [] }, { collections: [{ id: 3 }] }]) {
    assert.equal(parseRegistry(bad), null);
  }
});

test("the built-in playlists keep their old ids; every other collection's playlist has its own id", () => {
  assert.deepEqual(["examples", "mpb", "public-domain", "nottingham", "pdmx", "mine"].map(playlistIdOf), ["examples", "mpb", "choro", "folk", "classical", "mine"]);
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

test("a MIDI route names a file of the repository, which the page fetches from its own site", () => {
  const entry = { id: "m", t: "M", route: { midi: "../songs/mine/m.mid" } };
  assert.deepEqual(entryRequest(entry), { url: "../songs/mine/m.mid", kind: "midi" });
  assert.deepEqual(entryRequest({ id: "m", t: "M", route: { midi: "songs/mine/m.mid" } }), { url: "../songs/mine/m.mid", kind: "midi" }, "a path from the repository root");
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
  const { entries, missing, collections } = await loadCatalog(fetchFn, (list) => sizes.push(list.length));
  assert.deepEqual(asked.slice(0, 2), [REGISTRY_PATH, "data/catalog/examples.json"], "the registry first, then the examples");
  assert.deepEqual(sizes, [3, 7], "first the 3 examples, then the 7 songs of the small files");
  assert.equal(entries[0].id, "korobeiniki");
  assert.deepEqual(missing, []);
  assert.ok(!asked.includes("data/catalog/mpb.json"), "MPB is the largest file: it is read only when needed");
  assert.deepEqual(collections.filter((record) => record.lazy).map((record) => record.id), ["mpb"]);
});

test("the page is told which lazy collections have not arrived, with each update", async () => {
  const { fetchFn } = fakeFetch(catalogRoutes());
  /** @type {Array<{collections: string[], pending: string[]}>} */
  const views = [];
  const catalog = await loadCatalog(fetchFn, (_list, view) => views.push({ collections: view.collections.map((record) => record.id), pending: view.pending }));
  assert.deepEqual(views.map((view) => view.pending), [["mpb"], ["mpb"]]);
  assert.deepEqual(views[0].collections, ["examples", "mpb", "public-domain", "nottingham", "pdmx"]);
  await catalog.loadMore("mpb");
  assert.deepEqual(views.at(-1)?.pending, [], "nothing is pending once MPB is in");
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

// --- Loading the catalog through the registry --------------------------------------------------

/** A catalog file with a few songs of one collection. @param {string} id @param {string[]} titles */
const collectionFile = (id, titles) => ({
  body: JSON.stringify({
    source: id,
    entries: titles.map((title, i) => ({ id: `${id}-${i}`, t: title, route: { midi: `../songs/${id}/${i}.mid` } })),
  }),
});

/** @param {object[]} list @param {Record<string, any>} [more] */
const withRegistry = (list, more = {}) => ({
  ...catalogRoutes(),
  [REGISTRY_PATH]: { body: JSON.stringify({ collections: list }) },
  ...more,
});

test("the registry decides which files load: a new collection loads with the small files, no code change", async () => {
  const { fetchFn, asked } = fakeFetch(
    withRegistry([...FALLBACK_COLLECTIONS, sample("mine", { kind: "local-midi", order: 100 })], {
      "data/catalog/mine.json": collectionFile("mine", ["Zeta", "Alfa"]),
    }),
  );
  const { entries, collections, missing } = await loadCatalog(fetchFn);
  assert.ok(asked.includes("data/catalog/mine.json"));
  assert.deepEqual(entries.filter((entry) => entry.source === "mine").map((entry) => entry.t), ["Alfa", "Zeta"]);
  assert.deepEqual(collections.map((record) => record.id), ["examples", "mpb", "public-domain", "nottingham", "pdmx", "mine"]);
  assert.deepEqual(missing, []);
});

test("a disabled collection is not requested at all", async () => {
  const list = FALLBACK_COLLECTIONS.map((record) => (record.id === "nottingham" ? { ...record, enabled: false } : record));
  const { fetchFn, asked } = fakeFetch(withRegistry(list));
  const { entries, collections } = await loadCatalog(fetchFn);
  assert.ok(!asked.includes("data/catalog/nottingham.json"));
  assert.ok(!entries.some((entry) => entry.source === "nottingham"));
  assert.ok(!collections.some((record) => record.id === "nottingham"));
});

test("the first collection to load, which shows at once, is the first small one in the registry's order", async () => {
  const list = FALLBACK_COLLECTIONS.map((record) => (record.id === "pdmx" ? { ...record, order: 1 } : record));
  const { fetchFn, asked } = fakeFetch(withRegistry(list));
  await loadCatalog(fetchFn);
  assert.equal(asked[1], "data/catalog/pdmx.json");
});

test("a lazy flag in the registry makes any collection wait for loadMore, and a lazy MPB can be made eager", async () => {
  const list = FALLBACK_COLLECTIONS.map((record) =>
    record.id === "pdmx" ? { ...record, lazy: true } : record.id === "mpb" ? { ...record, lazy: false } : record,
  );
  const { fetchFn, asked } = fakeFetch(withRegistry(list));
  const catalog = await loadCatalog(fetchFn);
  assert.ok(asked.includes("data/catalog/mpb.json"));
  assert.ok(!asked.includes("data/catalog/pdmx.json"));
  assert.equal(catalog.entries.some((entry) => entry.source === "pdmx"), false);
  const more = await catalog.loadMore("pdmx");
  assert.ok(more.entries.some((entry) => entry.source === "pdmx"));
});

test("a collection whose file is missing is named in missing, and the others still load", async () => {
  const { fetchFn } = fakeFetch(withRegistry([...FALLBACK_COLLECTIONS, sample("ghost")]));
  const { missing, entries } = await loadCatalog(fetchFn);
  assert.deepEqual(missing, ["ghost"]);
  assert.ok(entries.length > 0);
});

test("an unreadable registry falls back to the built-in collections, so the app never shows nothing", async () => {
  for (const registry of [{ status: 404 }, { body: "{ not json" }, { body: JSON.stringify({ collections: [] }) }, /** @type {const} */ ("reject")]) {
    const { fetchFn } = fakeFetch({ ...catalogRoutes(), [REGISTRY_PATH]: registry });
    const { entries, collections } = await loadCatalog(fetchFn);
    assert.deepEqual(collections.map((record) => record.id), ["examples", "mpb", "public-domain", "nottingham", "pdmx"]);
    assert.equal(entries.length, 7);
  }
});

test("if the examples cannot be read the page still gets the other collections", async () => {
  const { fetchFn } = fakeFetch({ ...catalogRoutes(), "data/catalog/examples.json": { status: 500 } });
  const { entries, missing } = await loadCatalog(fetchFn);
  assert.deepEqual(missing, ["examples"]);
  assert.equal(entries.length, 4);
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

test("which files are lazy comes from the registry: a lazy collection is needed when its playlist is open", () => {
  const collections = [...FALLBACK_COLLECTIONS, sample("big", { kind: "remote", lazy: true })];
  const view = { searching: false, cachedKeys: [] };
  assert.deepEqual(lazySourcesNeeded({ playlistId: "big", ...view }, collections), ["big"]);
  assert.deepEqual(lazySourcesNeeded({ playlistId: "mpb", ...view }, collections), ["mpb"]);
  assert.deepEqual(lazySourcesNeeded({ playlistId: "popular", searching: true, cachedKeys: [] }, collections), ["mpb", "big"]);
  assert.deepEqual(lazySourcesNeeded({ playlistId: "big", searching: false, cachedKeys: ["big:x"] }, collections), ["big"]);
  const eager = FALLBACK_COLLECTIONS.map((record) => ({ ...record, lazy: false }));
  assert.deepEqual(lazySourcesNeeded({ playlistId: "mpb", searching: true, cachedKeys: [] }, eager), []);
  const classical = FALLBACK_COLLECTIONS.map((record) => (record.id === "pdmx" ? { ...record, lazy: true } : record));
  assert.deepEqual(lazySourcesNeeded({ playlistId: "classical", ...view }, classical), ["pdmx"], "the playlist id of pdmx is classical");
  const disabled = collections.map((record) => (record.id === "big" ? { ...record, enabled: false } : record));
  assert.deepEqual(lazySourcesNeeded({ playlistId: "big", ...view }, disabled), []);
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

test("opening a MIDI route fetches the file's bytes and names it after the song", async () => {
  const bytes = new Uint8Array([77, 84, 104, 100, 0, 0, 0, 6]);
  const { fetchFn, asked } = fakeFetch({ "../songs/mine/m.mid": { body: bytes } });
  const opened = await openEntry({ id: "m", t: "Minuet in G", route: { midi: "../songs/mine/m.mid" } }, { fetchFn });
  assert.equal(opened.kind, "midi");
  assert.equal(opened.name, "Minuet in G.mid");
  assert.deepEqual([...(opened.bytes ?? [])], [...bytes]);
  assert.deepEqual(asked, ["../songs/mine/m.mid"], "one request, to the app's own site");
});

test("a MIDI file that is gone says so in plain words", async () => {
  const entry = { id: "m", t: "M", route: { midi: "../songs/mine/m.mid" } };
  await assert.rejects(openEntry(entry, { fetchFn: fakeFetch({}).fetchFn }), { message: loadErrorMessage(404) });
  await assert.rejects(openEntry(entry, { fetchFn: fakeFetch({ "../songs/mine/m.mid": "reject" }).fetchFn }), { message: NETWORK_MESSAGE });
});

test("a song with a MIDI file of the repository carries its license, its credit and a way to keep the file", () => {
  const entry = { id: "m", t: "Minuet: in G", license: "CC-BY-4.0", credit: "https://example.org/c", route: { midi: "../songs/mine/m.mid" } };
  assert.deepEqual(licenseNotice(entry), { license: "CC-BY-4.0", credit: "https://example.org/c", link: "https://example.org/c" });
  assert.deepEqual(midiDownload(entry), { href: "../songs/mine/m.mid", name: "Minuet- in G.mid" });
  assert.deepEqual(licenseNotice({ ...entry, credit: "The author" }), { license: "CC-BY-4.0", credit: "The author", link: null });
  assert.deepEqual(licenseNotice({ ...entry, license: undefined, credit: undefined }), null, "nothing to say");
  assert.equal(midiDownload({ ...entry, route: { midi: "songs/mine/m.mid" } })?.href, "../songs/mine/m.mid");
});

test("songs of other routes have no license notice and no download: their files are not ours to give", () => {
  const mpb = fixture("mpb").entries[0];
  assert.equal(licenseNotice(mpb), null);
  assert.equal(midiDownload(mpb), null);
  assert.equal(midiDownload({ id: "a", t: "A", route: { abc: "x.abc" } }), null);
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

// --- Progress of a big file ---------------------------------------------------------------------

/**
 * A fetch that serves the registry-less catalog but sends MPB's file as a stream in pieces, with
 * its length announced, as a real server does.
 *
 * @param {number} pieces how many chunks the file arrives in
 */
function streamingFetch(pieces) {
  const routes = catalogRoutes();
  const fetchFn = async (/** @type {string} */ url) => {
    if (url !== "data/catalog/mpb.json") {
      const body = routes[url]?.body ?? "";
      return new Response(url === "data/catalog/collections.json" ? null : body, { status: url === "data/catalog/collections.json" ? 404 : 200 });
    }
    const bytes = new TextEncoder().encode(/** @type {string} */ (routes[url].body));
    const size = Math.ceil(bytes.length / pieces);
    let at = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (at >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(at, at + size));
        at += size;
      },
    });
    return new Response(body, { status: 200, headers: { "content-length": String(bytes.length) } });
  };
  return /** @type {any} */ (fetchFn);
}

test("a lazy file reports how much of it has arrived while it streams in, and still parses", async () => {
  /** @type {Array<[string, number, number]>} */
  const progress = [];
  const catalog = await loadCatalog(streamingFetch(4), () => {}, (source, { loaded, total }) => progress.push([source, loaded, total]));
  assert.deepEqual(progress, [], "nothing for the small files, and nothing before MPB is asked for");
  const more = await catalog.loadMore("mpb");
  assert.equal(more.entries.filter((entry) => entry.source === "mpb").length, 4, "the songs came out right");
  assert.ok(progress.length >= 2, "more than one report");
  assert.ok(progress.every(([source]) => source === "mpb"));
  const loaded = progress.map(([, bytes]) => bytes);
  assert.deepEqual(loaded, [...loaded].sort((a, b) => a - b), "it only grows");
  assert.equal(progress.at(-1)?.[1], progress.at(-1)?.[2], "the last report says all of it arrived");
});

test("a file with no announced length still reports the bytes that arrived, with total 0", async () => {
  const routes = catalogRoutes();
  const fetchFn = /** @type {any} */ (async (/** @type {string} */ url) =>
    url === "data/catalog/collections.json" ? new Response(null, { status: 404 }) : new Response(/** @type {string} */ (routes[url]?.body ?? ""), { status: 200 }));
  /** @type {number[]} */
  const totals = [];
  const catalog = await loadCatalog(fetchFn, () => {}, (_source, { total }) => totals.push(total));
  await catalog.loadMore("mpb");
  assert.ok(totals.length >= 1);
  assert.ok(totals.every((total) => total === 0));
});

// --- Prefetching the big file ---------------------------------------------------------------------

test("the big file is fetched ahead only on a connection that is not metered or slow", () => {
  assert.equal(shouldPrefetch(undefined), true, "no information: go ahead");
  assert.equal(shouldPrefetch({}), true);
  assert.equal(shouldPrefetch({ saveData: true }), false);
  assert.equal(shouldPrefetch({ effectiveType: "4g" }), true);
  for (const effectiveType of ["slow-2g", "2g", "3g"]) assert.equal(shouldPrefetch({ effectiveType }), false, effectiveType);
  assert.equal(shouldPrefetch({ type: "cellular" }), false);
  assert.equal(shouldPrefetch({ type: "wifi", effectiveType: "4g" }), true);
});

// --- The search index -------------------------------------------------------------------------------

test("warming the search index does not change what a search finds", () => {
  const catalog = mergeCatalog(allFiles());
  const before = searchCatalog(catalog, "teste").map((entry) => entry.id);
  warmSearchIndex(catalog);
  assert.deepEqual(searchCatalog(catalog, "teste").map((entry) => entry.id), before);
});

test("a search over thousands of songs takes a few milliseconds once the index is built", () => {
  const many = Array.from({ length: 4000 }, (_, i) => ({ id: `s${i}`, source: "mpb", t: `Canção número ${i} de teste`, c: `Compositor ${i % 50}`, p: "" }));
  warmSearchIndex(many);
  const started = performance.now();
  for (const query of ["can", "cao", "numero 12", "compositor 7"]) searchCatalog(many, query);
  assert.ok((performance.now() - started) / 4 < 30, "under 30 ms a keystroke");
});
