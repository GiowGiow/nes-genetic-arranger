// @ts-check
// Tests for core/online-sources.js: the sites the search box asks besides the catalog, how each
// answer becomes a list of results, and how a result becomes a record on the shelf. The answers
// here are small invented ones shaped like the real ones; the sites themselves are not asked.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SOURCE_NAMES,
  bitmidiResults,
  bitmidiSearchUrl,
  bitmidiTitle,
  createOnlineSources,
  imslpResults,
  workerResults,
} from "../src/core/online-sources.js";
import { externalEntry } from "../src/core/sources.js";
import { isFetchable } from "../src/core/midi-fetcher.js";

const BASE = "https://fetcher.example";

test("BitMidi is asked from the browser, for the first 20 results, with the words encoded", () => {
  assert.equal(bitmidiSearchUrl("arctic monkeys & co"), "https://bitmidi.com/api/midi/search?q=arctic%20monkeys%20%26%20co&page=0&pageSize=20");
});

test("a BitMidi file name becomes a readable title and, when it says so, an artist", () => {
  assert.deepEqual(bitmidiTitle("Ahmed Romel - Only For You (Arctic Moon Remix).mid"), { title: "Only For You (Arctic Moon Remix)", composer: "Ahmed Romel" });
  assert.deepEqual(bitmidiTitle("beatles-cant_buy_me_love.mid"), { title: "Beatles Cant Buy Me Love", composer: "" });
  assert.deepEqual(bitmidiTitle("Song_Name.MIDI"), { title: "Song Name", composer: "" });
  assert.deepEqual(bitmidiTitle(".mid"), { title: "Untitled", composer: "" });
});

const BITMIDI_ANSWER = {
  result: {
    results: [
      { id: 16424, name: "beatles-cant_buy_me_love.mid", slug: "beatles-cant_buy_me_love-mid", url: "/beatles-cant_buy_me_love-mid", downloadUrl: "/uploads/16424.mid" },
      { id: 4374, name: "Ahmed Romel - Only For You.mid", url: "/ahmed-romel-only-for-you-mid", downloadUrl: "/uploads/4374.mid" },
      { id: "x", name: "broken.mid" },
      { name: "no id.mid" },
    ],
  },
};

test("BitMidi results carry the song's page, its file in the uploads folder and an honest license", () => {
  const results = bitmidiResults(BITMIDI_ANSWER);
  assert.equal(results.length, 2, "a result with no numeric id is dropped");
  assert.deepEqual(results[0], {
    source: "bitmidi",
    id: "16424",
    title: "Beatles Cant Buy Me Love",
    composer: "",
    license: "Not stated by the site",
    format: "midi",
    page: "https://bitmidi.com/beatles-cant_buy_me_love-mid",
    open: "https://bitmidi.com/uploads/16424.mid",
  });
  assert.equal(results[1].composer, "Ahmed Romel");
});

test("an answer that is not what BitMidi sends gives no results", () => {
  assert.deepEqual(bitmidiResults({}), []);
  assert.deepEqual(bitmidiResults(null), []);
  assert.deepEqual(bitmidiResults({ result: { results: "nope" } }), []);
});

test("the Worker's midis101 and Mutopia answers become results, keeping only files on the right site", () => {
  const midis101 = workerResults("midis101", {
    results: [
      { id: "63384", title: "Arctic Monkeys When The Sun Goes Down", url: "https://www.midis101.com/free-midi/63384-x", midi: "https://www.midis101.com/download/63384-x" },
      { id: "9", title: "Wrong host", url: "https://www.midis101.com/free-midi/9-x", midi: "https://evil.example/download/9-x" },
    ],
  });
  assert.equal(midis101.length, 1);
  assert.equal(midis101[0].source, "midis101");
  assert.equal(midis101[0].open, "https://www.midis101.com/download/63384-x");
  assert.equal(midis101[0].license, "Not stated by the site");

  const mutopia = workerResults("mutopia", {
    results: [{ id: "578", title: "Little Piece", composer: "Anonymous", instrument: "Organ", license: "Public Domain", url: "https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=578", midi: "https://www.mutopiaproject.org/ftp/A/L/L.mid" }],
  });
  assert.deepEqual(mutopia[0], {
    source: "mutopia",
    id: "578",
    title: "Little Piece",
    composer: "Anonymous",
    license: "Public Domain",
    format: "midi",
    page: "https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=578",
    open: "https://www.mutopiaproject.org/ftp/A/L/L.mid",
  });
});

test("IMSLP is a link out: one result that opens its own search page, and no file", () => {
  const [link] = imslpResults("moonlight sonata");
  assert.equal(link.source, "imslp");
  assert.equal(link.format, "link");
  assert.equal(link.open, "https://imslp.org/index.php?search=moonlight%20sonata&title=Special%3ASearch&fulltext=Search");
  assert.match(link.title, /moonlight sonata/);
});

test("every source has a name the shelf can show", () => {
  assert.deepEqual(
    Object.keys(SOURCE_NAMES).sort(),
    ["bitmidi", "imslp", "midis101", "mutopia", "thesession"],
  );
});

test("a MIDI result becomes a download record the file fetcher can open; a link result opens a page", () => {
  const [bitmidi] = bitmidiResults(BITMIDI_ANSWER);
  const record = externalEntry(bitmidi);
  assert.deepEqual(record.route, { download: "https://bitmidi.com/uploads/16424.mid" });
  assert.equal(record.u, "https://bitmidi.com/beatles-cant_buy_me_love-mid");
  assert.equal(record.source, "bitmidi");
  assert.equal(isFetchable(record), true);
  assert.deepEqual(externalEntry(imslpResults("bach")[0]).route, { link: imslpResults("bach")[0].open });
});

// --- The sources ----------------------------------------------------------------------------

/** @param {Record<string, any>} answers by URL start */
function fakeFetch(answers) {
  /** @type {string[]} */
  const asked = [];
  const fetchFn = async (/** @type {string} */ url) => {
    asked.push(url);
    const key = Object.keys(answers).find((start) => url.startsWith(start));
    if (key === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => answers[key] };
  };
  return { fetchFn: /** @type {any} */ (fetchFn), asked };
}

test("the sources are The Session, BitMidi, midis101.com, the Mutopia Project and IMSLP, in that order", () => {
  const sources = createOnlineSources({ fetchFn: /** @type {any} */ (async () => ({})), workerUrl: BASE });
  assert.deepEqual(sources.map((source) => source.id), ["thesession", "bitmidi", "midis101", "mutopia", "imslp"]);
  assert.deepEqual(sources.map((source) => source.name), ["The Session", "BitMidi", "midis101.com", "Mutopia Project", "IMSLP"]);
});

test("each source asks its own address once and reads its own answer", async () => {
  const { fetchFn, asked } = fakeFetch({
    "https://thesession.org/": { tunes: [{ id: 7, name: "Pretend Jig", url: "https://thesession.org/tunes/7", type: "jig" }] },
    "https://bitmidi.com/api/": BITMIDI_ANSWER,
    [`${BASE}/search/midis101`]: { results: [{ id: "1", title: "A", url: "https://www.midis101.com/free-midi/1-a", midi: "https://www.midis101.com/download/1-a" }] },
    [`${BASE}/search/mutopia`]: { results: [] },
  });
  const sources = createOnlineSources({ fetchFn, workerUrl: BASE });
  const signal = new AbortController().signal;
  const found = await Promise.all(sources.map((source) => source.run("jig", { signal })));
  assert.deepEqual(found.map((results) => results.length), [1, 2, 1, 0, 1]);
  assert.equal(asked.length, 4, "IMSLP is a link: no request");
  assert.ok(asked.includes(`${BASE}/search/midis101?q=jig`));
});

test("a source that gets an error status fails with that status", async () => {
  const { fetchFn } = fakeFetch({});
  const [, bitmidi] = createOnlineSources({ fetchFn, workerUrl: BASE });
  await assert.rejects(bitmidi.run("jig", { signal: new AbortController().signal }), /404/);
});
