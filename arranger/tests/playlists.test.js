// @ts-check
// Tests for core/playlists.js: how the catalog is ordered by popularity and cut into playlists
// (the shelf's way to choose which song to play, instead of one list of thousands).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALBUM_MIN_SONGS,
  MPB_ALBUM_COUNT,
  POPULAR_SIZE,
  artistOf,
  buildPlaylists,
  canArrangeInOneClick,
  orderCatalog,
  popOf,
  searchByPopularity,
  sortByPopularity,
} from "../src/core/playlists.js";

/**
 * A made-up entry; `extra` overrides any field.
 * @param {string} id
 * @param {Record<string, unknown>} [extra]
 */
function entry(id, extra = {}) {
  return { id, source: "nottingham", t: `Tune ${id}`, c: "", p: "", seed: 1, route: { abc: `abc/${id}.abc`, tune: 0 }, ...extra };
}

/** @param {any[]} list */
const ids = (list) => list.map((item) => item.id);
/** @param {any[]} list @param {string} id */
const playlist = (list, id) => list.find((item) => item.id === id);

// --- Popularity order --------------------------------------------------------------------------

test("a song with no popularity counts as 0", () => {
  assert.equal(popOf(entry("a")), 0);
  assert.equal(popOf(entry("a", { pop: 7 })), 7);
});

test("songs sort by popularity, highest first; ties go to the examples' order, then the title", () => {
  const songs = [
    entry("zebra", { t: "Zebra", pop: 5 }),
    entry("alpha", { t: "Alpha", pop: 5 }),
    entry("hit", { t: "Hit", pop: 90 }),
    entry("second", { source: "examples", t: "Second", order: 2 }),
    entry("first", { source: "examples", t: "First", order: 1 }),
    entry("none", { t: "Água" }),
  ];
  assert.deepEqual(ids(sortByPopularity(songs)), ["hit", "alpha", "zebra", "first", "second", "none"]);
});

test("the title tie-break ignores accents and letter case, as the catalog does", () => {
  const sorted = sortByPopularity([entry("b", { t: "Zulu" }), entry("a", { t: "água" }), entry("c", { t: "Bola" })]);
  assert.deepEqual(ids(sorted), ["a", "c", "b"]);
});

test("sorting does not change the list it is given", () => {
  const songs = [entry("a", { pop: 1 }), entry("b", { pop: 2 })];
  sortByPopularity(songs);
  assert.deepEqual(ids(songs), ["a", "b"]);
});

test("the visitor's own songs stay at the head of the catalog, in the order given", () => {
  const ordered = orderCatalog([
    entry("x", { pop: 3 }),
    entry("own-1", { source: "local" }),
    entry("y", { pop: 9 }),
    entry("own-2", { source: "local" }),
  ]);
  assert.deepEqual(ids(ordered), ["own-1", "own-2", "y", "x"]);
});

// --- Search ------------------------------------------------------------------------------------

test("a search keeps the text ranking (starts with, then contains) and breaks ties by popularity", () => {
  const songs = [
    entry("contains-hit", { t: "My Samba", pop: 99 }),
    entry("starts-low", { t: "Samba Triste", pop: 1 }),
    entry("starts-high", { t: "Samba de Janeiro", pop: 50 }),
    entry("by-composer", { t: "Other", c: "Mr Samba", pop: 100 }),
    entry("no-match", { t: "Choro", pop: 1000 }),
  ];
  assert.deepEqual(ids(searchByPopularity(songs, "samba")), ["starts-high", "starts-low", "contains-hit", "by-composer"]);
});

test("a query under 2 letters gives the whole list", () => {
  const songs = [entry("a"), entry("b")];
  assert.equal(searchByPopularity(songs, "a"), songs);
});

// --- What opens in one click -------------------------------------------------------------------

test("a song opens in one click when it has an ABC route and no error; downloads and errors do not", () => {
  assert.equal(canArrangeInOneClick(entry("a")), true);
  assert.equal(canArrangeInOneClick(entry("a", { route: { abc: "x.abc" } })), true);
  assert.equal(canArrangeInOneClick(entry("a", { route: { tune: 3 } })), true);
  assert.equal(canArrangeInOneClick(entry("a", { route: { download: "https://example.org/a.mid" } })), false);
  assert.equal(canArrangeInOneClick(entry("a", { error: "broken" })), false);
  assert.equal(canArrangeInOneClick(entry("a", { route: undefined })), false);
});

test("a downloaded song that the visitor's browser remembers opens in one click too", () => {
  const download = entry("a", { source: "mpb", route: { download: "https://example.org/a.mid" } });
  const cached = (/** @type {{id: string}} */ candidate) => candidate.id === "a";
  assert.equal(canArrangeInOneClick(download, cached), true);
  assert.equal(canArrangeInOneClick(entry("b", { source: "mpb", route: { download: "x" } }), cached), false);
  assert.equal(canArrangeInOneClick(download, () => false), false);
  assert.equal(canArrangeInOneClick({ ...download, error: "broken" }, cached), false, "an error still wins");
  assert.equal(canArrangeInOneClick(entry("c", { route: undefined }), () => true), false, "no route, nothing to read");
});

// --- Artists -----------------------------------------------------------------------------------

test("the artist of an MPB song is its performer, or else its first composer", () => {
  assert.equal(artistOf(entry("a", { p: " Elis Regina ", c: "Tom Jobim" })), "Elis Regina");
  assert.equal(artistOf(entry("a", { p: "", c: "Benedito Lacerda, Nelson Angelo e Pixinguinha" })), "Benedito Lacerda");
  assert.equal(artistOf(entry("a", { p: "", c: "Ary Barroso e Luiz Peixoto" })), "Ary Barroso");
  assert.equal(artistOf(entry("a", { p: "", c: "" })), "");
});

// --- Playlists ---------------------------------------------------------------------------------

/** A catalog with every collection. */
function sampleCatalog() {
  return [
    entry("ex-b", { source: "examples", t: "Beta", order: 2, pop: 10 }),
    entry("ex-a", { source: "examples", t: "Alpha", order: 1 }),
    entry("pd-1", { source: "public-domain", t: "Choro 1", pop: 40, route: { abc: "pd.abc", tune: 0 } }),
    entry("pd-2", { source: "public-domain", t: "Choro 2", route: { download: "https://example.org/x.mid" } }),
    entry("nt-1", { source: "nottingham", t: "Reel", pop: 5 }),
    entry("pm-1", { source: "pdmx", t: "Sonata", pop: 8 }),
    entry("mpb-x", { source: "mpb", t: "Solo", p: "Someone", pop: 500, route: { download: "https://example.org/y.mid" } }),
  ];
}

test("the playlists come in a fixed order and each has an id, a name, a subtitle, songs and a cover", () => {
  const lists = buildPlaylists(sampleCatalog());
  assert.deepEqual(lists.map((item) => item.id), ["popular", "examples", "mpb", "choro", "folk", "classical"]);
  assert.deepEqual(lists.map((item) => item.name), ["Popular", "Examples", "MPB", "Choro & public domain", "Folk tunes", "Classical & standards"]);
  const examples = playlist(lists, "examples");
  assert.deepEqual(ids(examples.songs), ["ex-b", "ex-a"]);
  assert.equal(examples.subtitle, "2 songs");
  assert.equal(examples.cover.id, "ex-b", "the cover is the most popular song");
  assert.equal(playlist(lists, "folk").subtitle, "1 song");
});

test("Popular holds the songs that open in one click, by popularity, and leaves out downloads", () => {
  const lists = buildPlaylists(sampleCatalog());
  assert.deepEqual(ids(playlist(lists, "popular").songs), ["pd-1", "ex-b", "pm-1", "nt-1", "ex-a"]);
  assert.ok(!ids(playlist(lists, "popular").songs).includes("mpb-x"));
  assert.ok(!ids(playlist(lists, "popular").songs).includes("pd-2"));
});

test("Popular stops at 50 songs", () => {
  const many = Array.from({ length: 80 }, (_, i) => entry(`n${i}`, { pop: i }));
  const popular = playlist(buildPlaylists(many), "popular");
  assert.equal(popular.songs.length, POPULAR_SIZE);
  assert.equal(popular.songs[0].id, "n79");
  assert.equal(popular.subtitle, "50 songs");
});

test("the visitor's own songs head Popular, and make a Your songs playlist only when there are some", () => {
  assert.equal(playlist(buildPlaylists(sampleCatalog()), "yours"), undefined);
  const lists = buildPlaylists([entry("own-2", { source: "local", route: { local: true } }), entry("own-1", { source: "local", route: { local: true } }), ...sampleCatalog()]);
  assert.deepEqual(lists.slice(0, 2).map((item) => item.id), ["popular", "yours"]);
  assert.deepEqual(ids(playlist(lists, "popular").songs).slice(0, 3), ["own-2", "own-1", "pd-1"]);
  assert.deepEqual(ids(playlist(lists, "yours").songs), ["own-2", "own-1"], "newest first, as given");
});

test("a collection with no songs has no playlist", () => {
  assert.deepEqual(buildPlaylists([]), []);
  assert.deepEqual(buildPlaylists([entry("n", { source: "pdmx" })]).map((item) => item.id), ["popular", "classical"]);
});

test("Popular lists a remembered download among the songs that open in one click, by popularity", () => {
  const isCached = (/** @type {{id: string}} */ candidate) => candidate.id === "mpb-x";
  const popular = playlist(buildPlaylists(sampleCatalog(), { isCached }), "popular");
  assert.deepEqual(ids(popular.songs), ["mpb-x", "pd-1", "ex-b", "pm-1", "nt-1", "ex-a"]);
  assert.deepEqual(ids(playlist(buildPlaylists(sampleCatalog()), "popular").songs), ["pd-1", "ex-b", "pm-1", "nt-1", "ex-a"], "not without the cache");
});

test("while the MPB file is still loading, MPB has a tile with no count and no songs", () => {
  const catalog = sampleCatalog().filter((song) => song.source !== "mpb");
  const lists = buildPlaylists(catalog, { pending: ["mpb"] });
  assert.deepEqual(lists.map((item) => item.id), ["popular", "examples", "mpb", "choro", "folk", "classical"]);
  const mpb = playlist(lists, "mpb");
  assert.equal(mpb.name, "MPB");
  assert.equal(mpb.subtitle, "", "the count is unknown until the file arrives");
  assert.deepEqual(mpb.songs, []);
  assert.equal(mpb.pending, true);
  assert.equal(mpb.albums, undefined, "the albums come with the songs");
  assert.ok(mpb.cover, "it still has a cover");
  assert.equal(mpb.cover.source, "mpb");
});

test("once the MPB songs are here, the tile is the real playlist even if the page still lists MPB as pending", () => {
  const mpb = playlist(buildPlaylists(sampleCatalog(), { pending: ["mpb"] }), "mpb");
  assert.deepEqual(ids(mpb.songs), ["mpb-x"]);
  assert.equal(mpb.pending, undefined);
});

/** @param {string} artist @param {number} count @param {number} pop each song's popularity */
const albumSongs = (artist, count, pop) =>
  Array.from({ length: count }, (_, i) => entry(`${artist}-${i}`, { source: "mpb", p: artist, t: `${artist} song ${i}`, pop, route: { download: "x" } }));

test("MPB groups songs into one album per artist with at least 5 songs, the most popular artists first", () => {
  const catalog = [...albumSongs("Quiet", 6, 1), ...albumSongs("Loud", 5, 10), ...albumSongs("Few", 4, 1000), entry("lone", { source: "mpb", p: "", c: "", pop: 3 })];
  const mpb = playlist(buildPlaylists(catalog), "mpb");
  assert.equal(mpb.songs.length, 6 + 5 + 4 + 1);
  assert.deepEqual(mpb.albums.map((album) => album.name), ["Loud", "Quiet", "Other artists"], "ordered by the sum of popularity");
  assert.equal(mpb.albums[0].songs.length, 5);
  assert.equal(mpb.albums[0].subtitle, "5 songs");
  assert.equal(mpb.albums[0].cover.id, mpb.albums[0].songs[0].id);
  const other = mpb.albums.at(-1);
  assert.equal(other.id, "mpb-other");
  assert.deepEqual(ids(other.songs).sort(), ["Few-0", "Few-1", "Few-2", "Few-3", "lone"]);
  assert.equal(mpb.subtitle, "16 songs, 2 albums");
  assert.equal(ALBUM_MIN_SONGS, 5);
});

test("MPB shows at most 24 artist albums; the songs of the others go to Other artists", () => {
  const catalog = Array.from({ length: 30 }, (_, i) => albumSongs(`Artist ${String(i).padStart(2, "0")}`, 5, i + 1)).flat();
  const mpb = playlist(buildPlaylists(catalog), "mpb");
  assert.equal(mpb.albums.length, MPB_ALBUM_COUNT + 1);
  assert.equal(mpb.albums[0].name, "Artist 29");
  assert.equal(mpb.albums.at(-1)?.songs.length, 6 * 5, "the 6 least popular artists' songs");
});

test("a song's artist is its performer, falling back to its first composer", () => {
  const catalog = [
    ...Array.from({ length: 5 }, (_, i) => entry(`c${i}`, { source: "mpb", p: "", c: "Dorival Caymmi e Outro", route: { download: "x" } })),
  ];
  const mpb = playlist(buildPlaylists(catalog), "mpb");
  assert.deepEqual(mpb.albums.map((album) => album.name), ["Dorival Caymmi"]);
});

test("a playlist's songs never include another collection's", () => {
  const lists = buildPlaylists(sampleCatalog());
  assert.deepEqual(ids(playlist(lists, "choro").songs), ["pd-1", "pd-2"]);
  assert.deepEqual(ids(playlist(lists, "mpb").songs), ["mpb-x"]);
});
