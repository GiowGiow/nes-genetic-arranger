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
  playlistAlias,
  popOf,
  searchByPopularity,
  sortByPopularity,
} from "../src/core/playlists.js";
import { FALLBACK_COLLECTIONS } from "../src/core/sources.js";

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

test("a song the file fetcher can bring opens in one click when the page says so", () => {
  const fetchable = entry("a", { source: "mpb", route: { download: "https://www.beakauffmann.com/a.mid" } });
  const canFetch = (/** @type {{id: string}} */ candidate) => candidate.id === "a";
  assert.equal(canArrangeInOneClick(fetchable, canFetch), true);
  assert.equal(canArrangeInOneClick(fetchable), false, "no fetcher, no cache: a download");
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

test("the playlists come in a fixed order: Catalog first, then the collections; Examples has none of its own", () => {
  const lists = buildPlaylists(sampleCatalog());
  assert.deepEqual(lists.map((item) => item.id), ["catalog", "mpb", "choro", "folk", "classical"]);
  assert.deepEqual(lists.map((item) => item.name), ["Catalog", "MPB", "Choro & public domain", "Folk tunes", "Classical & standards"]);
  assert.equal(playlist(lists, "folk").subtitle, "1 song");
  assert.equal(playlist(lists, "examples"), undefined);
});

test("Catalog starts with the examples in their own order, then the songs that open in one click, by popularity", () => {
  const lists = buildPlaylists(sampleCatalog());
  assert.deepEqual(ids(playlist(lists, "catalog").songs), ["ex-a", "ex-b", "pd-1", "pm-1", "nt-1"]);
  assert.ok(!ids(playlist(lists, "catalog").songs).includes("mpb-x"), "a download is not one click");
  assert.ok(!ids(playlist(lists, "catalog").songs).includes("pd-2"));
  assert.equal(playlist(lists, "catalog").cover.id, "pd-1", "the cover is the most popular song");
});

test("Catalog holds the examples and then at most 50 of the other songs", () => {
  const many = [
    entry("ex-1", { source: "examples", order: 1 }),
    entry("ex-2", { source: "examples", order: 2 }),
    ...Array.from({ length: 80 }, (_, i) => entry(`n${i}`, { pop: i })),
  ];
  const catalog = playlist(buildPlaylists(many), "catalog");
  assert.equal(catalog.songs.length, 2 + POPULAR_SIZE);
  assert.deepEqual(ids(catalog.songs).slice(0, 3), ["ex-1", "ex-2", "n79"]);
  assert.equal(catalog.subtitle, "52 songs");
});

test("the visitor's own songs head Catalog, and make a Your songs playlist (the last one) only when there are some", () => {
  assert.equal(playlist(buildPlaylists(sampleCatalog()), "yours"), undefined);
  const lists = buildPlaylists([entry("own-2", { source: "local", route: { local: true } }), entry("own-1", { source: "local", route: { local: true } }), ...sampleCatalog()]);
  assert.equal(lists.at(-1)?.id, "yours");
  assert.deepEqual(ids(playlist(lists, "catalog").songs).slice(0, 4), ["own-2", "own-1", "ex-a", "ex-b"]);
  assert.deepEqual(ids(playlist(lists, "yours").songs), ["own-2", "own-1"], "newest first, as given");
});

test("a collection with no songs has no playlist", () => {
  assert.deepEqual(buildPlaylists([]), []);
  assert.deepEqual(buildPlaylists([entry("n", { source: "pdmx" })]).map((item) => item.id), ["catalog", "classical"]);
});

test("Catalog lists a remembered or fetchable download among the one-click songs, by popularity", () => {
  const isOneClick = (/** @type {{id: string}} */ candidate) => candidate.id === "mpb-x";
  const catalog = playlist(buildPlaylists(sampleCatalog(), { isOneClick }), "catalog");
  assert.deepEqual(ids(catalog.songs), ["ex-a", "ex-b", "mpb-x", "pd-1", "pm-1", "nt-1"]);
  assert.deepEqual(ids(playlist(buildPlaylists(sampleCatalog()), "catalog").songs), ["ex-a", "ex-b", "pd-1", "pm-1", "nt-1"], "not without it");
});

test("a playlist id the app used to have leads to Catalog", () => {
  assert.equal(playlistAlias("popular"), "catalog");
  assert.equal(playlistAlias("examples"), "catalog");
  assert.equal(playlistAlias("mpb"), "mpb");
  assert.equal(playlistAlias(null), "catalog");
});

test("while the MPB file is still loading, MPB has a tile with no count and no songs", () => {
  const catalog = sampleCatalog().filter((song) => song.source !== "mpb");
  const lists = buildPlaylists(catalog, { pending: ["mpb"] });
  assert.deepEqual(lists.map((item) => item.id), ["catalog", "mpb", "choro", "folk", "classical"]);
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

// --- The registry's collections ----------------------------------------------------------------

/**
 * A registry record, as `data/catalog/collections.json` lists it.
 * @param {string} id
 * @param {Record<string, unknown>} [extra]
 */
const record = (id, extra = {}) => ({
  id,
  path: `data/catalog/${id}.json`,
  name: id,
  kind: "local-midi",
  lazy: false,
  order: 100,
  enabled: true,
  ...extra,
});

/** @param {string} id @param {Record<string, unknown>} [extra] a song of the collection "mine" */
const mine = (id, extra = {}) =>
  entry(id, { source: "mine", t: `Song ${id}`, route: { midi: `../songs/${id}.mid` }, ...extra });

test("a song with a MIDI file of the repository opens in one click, unless it has an error", () => {
  assert.equal(canArrangeInOneClick(mine("a")), true);
  assert.equal(canArrangeInOneClick(mine("a", { error: "no pitched notes" })), false);
});

test("a registered collection is a playlist of its own, named and placed by the registry", () => {
  const collections = [...FALLBACK_COLLECTIONS, record("mine", { name: "My songs", order: 25 })];
  const lists = buildPlaylists([...sampleCatalog(), mine("a")], { collections });
  assert.deepEqual(
    lists.map((item) => item.id),
    ["catalog", "mpb", "mine", "choro", "folk", "classical"],
    "order 25 comes after MPB (20) and before the public-domain playlist (30)",
  );
  assert.equal(playlist(lists, "mine").name, "My songs");
  assert.equal(playlist(lists, "mine").subtitle, "1 song");
});

test("a collection renamed or moved in the registry is renamed and moved in the app", () => {
  const collections = FALLBACK_COLLECTIONS.map((item) =>
    item.id === "pdmx" ? { ...item, name: "Old masters", order: 5 } : item.id === "mpb" ? { ...item, name: "Brazil" } : item,
  );
  const lists = buildPlaylists(sampleCatalog(), { collections });
  assert.deepEqual(lists.map((item) => item.name), ["Catalog", "Old masters", "Brazil", "Choro & public domain", "Folk tunes"]);
  assert.equal(playlist(lists, "classical").name, "Old masters", "the playlist keeps its id, so a remembered choice still works");
});

test("a disabled collection has no playlist, and its songs are not offered", () => {
  const collections = FALLBACK_COLLECTIONS.map((item) => (item.id === "nottingham" ? { ...item, enabled: false } : item));
  const lists = buildPlaylists(sampleCatalog(), { collections });
  assert.equal(playlist(lists, "folk"), undefined);
  assert.ok(!ids(playlist(lists, "catalog").songs).includes("nt-1"));
});

test("songs of a collection nobody registered are not listed", () => {
  const lists = buildPlaylists([...sampleCatalog(), mine("a")]);
  assert.equal(playlist(lists, "mine"), undefined);
  assert.ok(!ids(playlist(lists, "catalog").songs).includes("a"));
});

test("a collection's songs follow its default sort: popularity, title or order", () => {
  const songs = [
    mine("a", { t: "Zebra", pop: 5, order: 1 }),
    mine("b", { t: "Água", pop: 90, order: 3 }),
    mine("c", { t: "Bola", pop: 90, order: 2 }),
    mine("d", { t: "Casa" }),
  ];
  /** @param {string} sort */
  const listed = (sort) => ids(playlist(buildPlaylists(songs, { collections: [record("mine", { default_sort: sort })] }), "mine").songs);
  assert.deepEqual(listed("popularity"), ["c", "b", "a", "d"], "best known first; equal popularity goes to the order number");
  assert.deepEqual(listed("title"), ["b", "c", "d", "a"], "without accents or letter case");
  assert.deepEqual(listed("order"), ["a", "c", "b", "d"], "the order numbers; songs without one come last, by title");
  assert.deepEqual(
    ids(playlist(buildPlaylists(songs, { collections: [record("mine")] }), "mine").songs),
    ["c", "b", "a", "d"],
    "popularity when the registry does not say",
  );
});

test("a collection's songs with an album field become albums, in the order the sort gives", () => {
  const songs = [
    mine("a", { album: "Bach", pop: 10 }),
    mine("b", { album: "Mozart", pop: 90 }),
    mine("c", { album: "Bach", pop: 80 }),
    mine("d", { pop: 1 }),
  ];
  const list = playlist(buildPlaylists(songs, { collections: [record("mine")] }), "mine");
  assert.deepEqual(list.albums.map((album) => album.name), ["Mozart", "Bach", "Other songs"], "by the first song of each");
  assert.deepEqual(ids(list.albums[1].songs), ["c", "a"]);
  assert.deepEqual(list.albums.map((album) => album.subtitle), ["1 song", "2 songs", "1 song"]);
  assert.equal(list.subtitle, "4 songs, 2 albums");
  assert.equal(list.albums[0].id, "mine-album-mozart");
  assert.equal(list.albums.at(-1)?.id, "mine-other");
  assert.equal(list.albums[1].cover.id, "c", "an album's cover is its first song");
});

test("a collection with no album field, or only one album and nothing else, has no second level", () => {
  const plain = playlist(buildPlaylists([mine("a"), mine("b")], { collections: [record("mine")] }), "mine");
  assert.equal(plain.albums, undefined);
  const single = playlist(buildPlaylists([mine("a", { album: "Only" }), mine("b", { album: "Only" })], { collections: [record("mine")] }), "mine");
  assert.equal(single.albums, undefined);
  assert.equal(single.subtitle, "2 songs");
});

test("a collection's cover is its most popular song, or else its first", () => {
  const popular = playlist(buildPlaylists([mine("a", { pop: 1 }), mine("b", { pop: 9 })], { collections: [record("mine", { default_sort: "title" })] }), "mine");
  assert.equal(popular.cover.id, "b");
  const unranked = playlist(buildPlaylists([mine("b", { t: "B" }), mine("a", { t: "A" })], { collections: [record("mine", { default_sort: "title" })] }), "mine");
  assert.equal(unranked.cover.id, "a", "no popularity: the first song of the list");
});

test("a collection's songs enter Catalog by their popularity, like any other song that opens in one click", () => {
  const collections = [...FALLBACK_COLLECTIONS, record("mine")];
  const lists = buildPlaylists([...sampleCatalog(), mine("hit", { pop: 100000 }), mine("quiet", { pop: 2 })], { collections });
  assert.equal(playlist(lists, "catalog").songs[2].id, "hit", "after the two examples");
  assert.ok(ids(playlist(lists, "catalog").songs).includes("quiet"));
});

test("a remote collection groups its songs into artist albums, whatever its id", () => {
  const songs = Array.from({ length: 5 }, (_, i) =>
    entry(`s${i}`, { source: "links", p: "Band", t: `Song ${i}`, route: { download: "https://example.org/x.mid" } }),
  );
  const list = playlist(buildPlaylists(songs, { collections: [record("links", { kind: "remote" })] }), "links");
  assert.deepEqual(list.albums.map((album) => album.name), ["Band"]);
  assert.equal(list.albums[0].id, "links-band");
  assert.equal(list.subtitle, "5 songs, 1 album");
});

test("a lazy collection shows a tile with the registry's name and no count until its file arrives", () => {
  const collections = [...FALLBACK_COLLECTIONS, record("big", { name: "Big list", kind: "remote", lazy: true })];
  const lists = buildPlaylists(sampleCatalog(), { collections, pending: ["big"] });
  const big = playlist(lists, "big");
  assert.equal(big.name, "Big list");
  assert.equal(big.pending, true);
  assert.equal(big.subtitle, "");
  assert.equal(big.cover.source, "big");
  assert.equal(playlist(buildPlaylists(sampleCatalog(), { collections }), "big"), undefined, "not pending, not loaded: no tile");
});

test("the built-in collections keep their old playlist ids so a remembered choice still works", () => {
  assert.deepEqual(
    buildPlaylists(sampleCatalog()).map((item) => item.id),
    ["catalog", "mpb", "choro", "folk", "classical"],
  );
});
