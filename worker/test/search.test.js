// Tests for src/search.js: reading the search pages of midis101.com and the Mutopia Project.
// The pages are the sites' HTML, so these tests run on small hand-written pages with the same
// structure (test/fixtures/), not on copies of the sites' pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_QUERY_LENGTH,
  MAX_RESULTS,
  cleanQuery,
  midis101SearchUrl,
  mutopiaSearchUrl,
  parseMidis101,
  parseMutopia,
} from "../src/search.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

// ---- the visitor's words --------------------------------------------------------------

test("a query is trimmed and its spaces are squeezed", () => {
  assert.equal(cleanQuery("  arctic   monkeys "), "arctic monkeys");
});

test("a query of one letter, an empty one, a missing one or a very long one is refused", () => {
  assert.equal(cleanQuery("a"), null);
  assert.equal(cleanQuery("   "), null);
  assert.equal(cleanQuery(null), null);
  assert.equal(cleanQuery("x".repeat(MAX_QUERY_LENGTH + 1)), null);
  assert.equal(cleanQuery("x".repeat(MAX_QUERY_LENGTH)), "x".repeat(MAX_QUERY_LENGTH));
});

test("the search addresses carry the words encoded, and nothing else", () => {
  assert.equal(midis101SearchUrl("arctic monkeys").href, "https://www.midis101.com/search/arctic%20monkeys");
  assert.equal(midis101SearchUrl("a/b?c#d").href, "https://www.midis101.com/search/a%2Fb%3Fc%23d");
  const mutopia = mutopiaSearchUrl("bach & sons");
  assert.equal(mutopia.origin + mutopia.pathname, "https://www.mutopiaproject.org/cgibin/make-table.cgi");
  assert.deepEqual([...mutopia.searchParams], [["searchingfor", "bach & sons"]]);
});

// ---- midis101.com ---------------------------------------------------------------------

test("midis101: every song of the table becomes a result with its page and its file", () => {
  const results = parseMidis101(fixture("midis101-search.html"));
  assert.deepEqual(results[0], {
    id: "1001",
    title: "Example Band First Song",
    url: "https://www.midis101.com/free-midi/1001-example-band-first-song",
    midi: "https://www.midis101.com/download/1001-example-band-first-song",
  });
});

test("midis101: html entities in a title are decoded", () => {
  const [, second] = parseMidis101(fixture("midis101-search.html"));
  assert.equal(second.title, "Example Band Rock & Roll");
});

test("midis101: links that are not song pages of the site are ignored", () => {
  const results = parseMidis101(fixture("midis101-search.html"));
  assert.deepEqual(results.map((result) => result.id), ["1001", "1002"]);
});

test("midis101: a page with no table, or not a page at all, gives no results", () => {
  assert.deepEqual(parseMidis101("<html><body>No results</body></html>"), []);
  assert.deepEqual(parseMidis101(""), []);
});

test("midis101: at most MAX_RESULTS results, and a song listed twice once", () => {
  const row = (id) => `<td><a href="/free-midi/${id}-song-${id}">Song ${id}</a></td>`;
  const many = Array.from({ length: MAX_RESULTS + 10 }, (_, i) => row(i + 1)).join("") + row(1);
  const results = parseMidis101(`<table>${many}</table>`);
  assert.equal(results.length, MAX_RESULTS);
  assert.equal(new Set(results.map((result) => result.id)).size, MAX_RESULTS);
});

// ---- Mutopia --------------------------------------------------------------------------

test("mutopia: a piece with a MIDI file gives its title, composer, license, page and file", () => {
  const [first] = parseMutopia(fixture("mutopia-search.html"));
  assert.deepEqual(first, {
    id: "578",
    title: "Little Test Piece",
    composer: "Anonymous",
    instrument: "Organ",
    license: "Public Domain",
    url: "https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=578",
    midi: "https://www.mutopiaproject.org/ftp/Anonymous/Little/Little.mid",
  });
});

test("mutopia: a piece whose MIDI files come only zipped is left out", () => {
  const results = parseMutopia(fixture("mutopia-search.html"));
  assert.equal(results.some((result) => result.id === "674"), false);
});

test("mutopia: a MIDI link that is not on the project's own file area is left out", () => {
  const results = parseMutopia(fixture("mutopia-search.html"));
  assert.equal(results.some((result) => result.id === "900"), false);
  assert.equal(results.length, 1);
});

test("mutopia: the 'by' of a composer line is dropped and entities are decoded", () => {
  const html = fixture("mutopia-search.html").replace("Anonymous</td>\n<td>&nbsp;", "by Johann &amp; Co. (1685&ndash;1750)</td>\n<td>&nbsp;");
  assert.equal(parseMutopia(html)[0].composer, "Johann & Co. (1685–1750)");
});

test("mutopia: a page with no pieces gives no results", () => {
  assert.deepEqual(parseMutopia("<html><body>nothing</body></html>"), []);
});
