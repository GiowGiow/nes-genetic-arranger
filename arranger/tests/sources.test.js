// @ts-check
// Tests for core/sources.js: one catalog made of the per-source catalog files, its search and
// pages, and the routes that load a song (spec 005, stories 3 to 5, research R8). The catalog
// files here are small synthetic fixtures in tests/fixtures/catalog/, shaped like
// contracts/catalog-files.md; every title and name in them is invented.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  CATALOG_FILES,
  displayTitle,
  OFFLINE_MESSAGE,
  PAGE_MESSAGE,
  PRODUCTION_SERVER,
  entryRequest,
  externalEntry,
  fnv1a,
  loadCatalog,
  loadErrorMessage,
  mergeCatalog,
  mergeSearchResults,
  openEntry,
  pageCount,
  pageOf,
  searchCatalog,
  seedOf,
  serverUrl,
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

test("the song server is on this machine when the page is, and the production host otherwise", () => {
  assert.equal(serverUrl({ hostname: "localhost" }), "http://localhost:8765");
  assert.equal(serverUrl({ hostname: "127.0.0.1" }), "http://127.0.0.1:8765");
  assert.equal(serverUrl({ hostname: "giowgiow.github.io" }, true), "https://nes-arranger-bh.giow.dev");
  assert.equal(serverUrl({ hostname: "giowgiow.github.io" }), null, "the published page has no server until it is deployed");
  assert.equal(PRODUCTION_SERVER, "https://nes-arranger-bh.giow.dev");
});

test("a repository ABC route loads from the repository, next to the app folder", () => {
  const [korobeiniki] = mergeCatalog([fixture("examples")]);
  assert.deepEqual(entryRequest(korobeiniki, PRODUCTION_SERVER), {
    url: "../data/leadsheets/korobeiniki.abc",
    kind: "abc",
    tune: 0,
  });
  const jig = { id: "j", t: "J", route: { abc: "../data/catalog/abc/nottingham/jigs.abc", tune: 2 } };
  assert.deepEqual(entryRequest(jig, PRODUCTION_SERVER), { url: "../data/catalog/abc/nottingham/jigs.abc", kind: "abc", tune: 2 });
});

test("a server route loads the lead sheet from the song server", () => {
  const entry = fixture("mpb").entries[0];
  assert.deepEqual(entryRequest(entry, "http://localhost:8765"), {
    url: "http://localhost:8765/songs/mpb/agua-de-lua.abc",
    kind: "abc",
  });
  const file = { id: "f", t: "F", route: { server: "/files/web/123", format: "midi" } };
  assert.deepEqual(entryRequest(file, PRODUCTION_SERVER), { url: `${PRODUCTION_SERVER}/files/web/123`, kind: "midi" });
});

test("browser and link routes, and a song without a route", () => {
  assert.deepEqual(entryRequest({ id: "7", t: "T", route: { thesession: 7, setting: 1 } }, PRODUCTION_SERVER), {
    url: "https://thesession.org/tunes/7?format=json",
    kind: "thesession",
    setting: 1,
  });
  assert.deepEqual(entryRequest({ id: "w", t: "W", route: { link: "https://example.org/work" } }, PRODUCTION_SERVER), {
    url: "https://example.org/work",
    kind: "link",
  });
  const broken = fixture("mpb").entries.find((/** @type {any} */ entry) => entry.error);
  assert.equal(entryRequest(broken, PRODUCTION_SERVER), null);
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

test("the examples load first and show at once; the rest of the catalog follows", async () => {
  const { fetchFn, asked } = fakeFetch(catalogRoutes());
  /** @type {number[]} */
  const sizes = [];
  const { entries, missing } = await loadCatalog(fetchFn, (list) => sizes.push(list.length));
  assert.equal(asked[0], "data/catalog/examples.json");
  assert.deepEqual(sizes, [3, 11], "first the 3 examples, then all 11 songs");
  assert.equal(entries[0].id, "korobeiniki");
  assert.deepEqual(missing, []);
});

test("a catalog file that is missing or unreachable is skipped, and the others still load", async () => {
  const routes = { ...catalogRoutes(), "data/catalog/pdmx.json": { status: 404 }, "data/catalog/mpb.json": /** @type {const} */ ("reject") };
  const { fetchFn } = fakeFetch(routes);
  const { entries, missing } = await loadCatalog(fetchFn);
  assert.deepEqual(missing, ["mpb", "pdmx"]);
  assert.equal(entries.length, 6);
});

// --- Opening a song ---------------------------------------------------------------------------

test("opening a repository song reads its ABC, and only its tune of the collection", async () => {
  const collection = "% header\nX:1\nT:First\nK:C\nC4|\n\nX:2\nT:Second\nK:G\nG4|\n";
  const { fetchFn } = fakeFetch({ "../data/catalog/abc/nottingham/jigs.abc": { body: collection } });
  const entry = { id: "jigs-2", t: "Second", route: { abc: "data/catalog/abc/nottingham/jigs.abc", tune: 1 } };
  const opened = await openEntry(entry, { fetchFn, server: PRODUCTION_SERVER });
  assert.deepEqual(opened, { kind: "abc", name: "Second.abc", text: "% header\nX:2\nT:Second\nK:G\nG4|\n" });
});

test("opening a server song reads the lead sheet the server reduced", async () => {
  const server = "http://localhost:8765";
  const { fetchFn } = fakeFetch({ [`${server}/songs/mpb/agua-de-lua.abc`]: { body: "X:1\nT:Agua\nK:D\nD4|\n" } });
  const opened = await openEntry(fixture("mpb").entries[0], { fetchFn, server });
  assert.equal(opened.kind, "abc");
  assert.equal(opened.text, "X:1\nT:Agua\nK:D\nD4|\n");
  assert.equal(opened.name, "Água de Lua.abc");
});

test("opening a MIDI file from the server gives its bytes", async () => {
  const bytes = Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6]);
  const { fetchFn } = fakeFetch({ [`${PRODUCTION_SERVER}/files/web/9`]: { body: bytes } });
  const entry = { id: "9", t: "A/B tune", route: { server: "/files/web/9", format: "midi" } };
  const opened = await openEntry(entry, { fetchFn, server: PRODUCTION_SERVER });
  assert.equal(opened.kind, "midi");
  assert.equal(opened.name, "A-B tune.mid", "no slash in a file name");
  assert.deepEqual(opened.bytes, bytes);
});

test("a song without a page of its own, and a server that does not answer, is called offline", async () => {
  const { fetchFn } = fakeFetch({ [`${PRODUCTION_SERVER}/songs/mpb/agua-de-lua.abc`]: "reject" });
  const entry = { ...fixture("mpb").entries[0], u: undefined };
  await assert.rejects(openEntry(entry, { fetchFn, server: PRODUCTION_SERVER }), { message: OFFLINE_MESSAGE });
  assert.match(OFFLINE_MESSAGE, /song server is offline/);
  assert.match(OFFLINE_MESSAGE, /examples/);
});

test("with no song server, or one that does not answer, an MPB song opens the way it did before: its page, by hand", async () => {
  const entry = { ...fixture("mpb").entries[0], u: "https://example.org/songs/agua-de-lua.html" };
  const expected = { kind: "link", name: "Água de lua", url: "https://example.org/songs/agua-de-lua.html", byHand: true };
  const noServer = fakeFetch({});
  const opened = await openEntry(entry, { fetchFn: noServer.fetchFn, server: null });
  assert.equal(opened.kind, "link");
  assert.equal(opened.url, expected.url);
  assert.equal(opened.byHand, true);
  assert.equal(noServer.asked.length, 0, "no request goes out when there is no server");

  const down = fakeFetch({ [`${PRODUCTION_SERVER}/songs/mpb/agua-de-lua.abc`]: "reject" });
  const afterFailure = await openEntry(entry, { fetchFn: down.fetchFn, server: PRODUCTION_SERVER });
  assert.equal(afterFailure.kind, "link");
  assert.equal(afterFailure.byHand, true);

  for (const status of [502, 503, 504]) {
    const broken = fakeFetch({ [`${PRODUCTION_SERVER}/songs/mpb/agua-de-lua.abc`]: { status, body: "" } });
    const fallback = await openEntry(entry, { fetchFn: broken.fetchFn, server: PRODUCTION_SERVER });
    assert.equal(fallback.kind, "link", `HTTP ${status} falls back to the page`);
  }
  assert.match(PAGE_MESSAGE, /download the MIDI/);
});

test("entries from files in the repository never need the server", async () => {
  const korobeiniki = fixture("examples").entries[0];
  const { fetchFn } = fakeFetch({ ["../data/leadsheets/korobeiniki.abc"]: { body: "X:1\nT:K\nK:Am\nA|\n" } });
  const opened = await openEntry(korobeiniki, { fetchFn, server: null });
  assert.equal(opened.kind, "abc");
});

test("server answers become plain sentences: changed at its source, cannot be arranged, other errors", async () => {
  for (const [status, expected] of /** @type {Array<[number, RegExp]>} */ ([
    [409, /changed at its source/],
    [422, /cannot be arranged/],
    [404, /not available/],
    [429, /Wait a minute/],
    [502, /did not answer/],
    [500, /HTTP 500/],
  ])) {
    const { fetchFn } = fakeFetch({ [`${PRODUCTION_SERVER}/songs/mpb/agua-de-lua.abc`]: { status, body: '{"error": "upstream says something"}' } });
    await assert.rejects(openEntry({ ...fixture("mpb").entries[0], u: undefined }, { fetchFn, server: PRODUCTION_SERVER }), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, expected);
      assert.equal(error.message, loadErrorMessage(status));
      assert.doesNotMatch(error.message, /upstream says/, "the app writes its own sentence");
      return true;
    });
  }
});

test("the doc comment's load messages", () => {
  assert.equal(loadErrorMessage(409), "This song changed at its source since the catalog was made, so it cannot be opened.");
  assert.equal(loadErrorMessage(500), "The song could not be loaded (HTTP 500).");
});

test("no load message names a source site", () => {
  for (const status of [400, 404, 409, 413, 415, 422, 429, 500, 502, 503]) {
    assert.doesNotMatch(loadErrorMessage(status), SOURCE_SITE_NAMES);
    assert.match(loadErrorMessage(status), /\.$/, "a full sentence");
  }
  assert.doesNotMatch(OFFLINE_MESSAGE, SOURCE_SITE_NAMES);
});

test("a link-only song is not fetched: the caller opens its page", async () => {
  const { fetchFn, asked } = fakeFetch({});
  const entry = { id: "w", t: "Work", route: { link: "https://example.org/work" } };
  assert.deepEqual(await openEntry(entry, { fetchFn, server: PRODUCTION_SERVER }), { kind: "link", name: "Work", url: "https://example.org/work" });
  assert.equal(asked.length, 0);
});

test("a song without a route cannot be opened, and says so", async () => {
  const broken = fixture("mpb").entries.find((/** @type {any} */ entry) => entry.error);
  const { fetchFn, asked } = fakeFetch({});
  await assert.rejects(openEntry(broken, { fetchFn, server: PRODUCTION_SERVER }), /cannot be arranged/);
  assert.equal(asked.length, 0);
});

test("a tune from the folk tune site opens as MIDI made in the browser (synthetic tune)", async () => {
  // Invented tune, shaped like the site's tune JSON: never real data (constitution 2.0.0).
  const tune = { id: 90001, name: "The Made-up Polka", type: "polka", settings: [{ id: 1, key: "Gmajor", abc: '|:"G"GA Bc|dB GB|"D"A2 F2|D4:|' }] };
  const { fetchFn } = fakeFetch({ "https://thesession.org/tunes/90001?format=json": { body: JSON.stringify(tune) } });
  const entry = { id: "90001", source: "thesession", t: "The Made-up Polka", route: { thesession: 90001, setting: 0 } };
  const opened = await openEntry(entry, { fetchFn, server: PRODUCTION_SERVER, abcjs: loadAbcjs() });
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
    source: "web",
    id: "123",
    title: "Invented Gavotte",
    composer: "Nobody Real",
    license: "CC0",
    format: "midi",
    page: "https://example.org/123",
    open: "/files/web/123",
  };
  const entry = externalEntry(result);
  assert.deepEqual(entry, {
    id: "123",
    source: "web",
    t: "Invented Gavotte",
    c: "Nobody Real",
    license: "CC0",
    seed: seedOf("web", "123"),
    route: { server: "/files/web/123", format: "midi" },
  });
  assert.deepEqual(externalEntry({ ...result, format: "link", open: "https://example.org/123" }).route, { link: "https://example.org/123" });
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
    { source: "web", id: "5", title: "Invented Five", composer: "", license: "CC0", format: "midi", page: "", open: "/files/web/5" },
    { source: "web", id: "5", title: "Invented Five", composer: "", license: "CC0", format: "midi", page: "", open: "/files/web/5" },
  ];
  const merged = mergeSearchResults(local, external);
  assert.deepEqual(merged.map((entry) => `${entry.source}:${entry.id}`), ["nottingham:reels-1", "nottingham:jigs-3", "web:5"]);
  assert.equal(merged[0], local[0], "local entries stay as they are");
});
