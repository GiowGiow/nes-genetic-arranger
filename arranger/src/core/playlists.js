// @ts-check
/**
 * Playlists: how the catalog is ordered and cut into short lists a visitor can choose from.
 *
 * One list of four thousand songs is a poor way to pick a song to play. The catalog therefore
 * has two orders and a handful of shelves:
 *
 * - Every list is ordered by popularity (`pop`, higher is more popular), so the songs people
 *   know come first. Songs with the same popularity keep the examples' own order, then fall
 *   back to the title, which makes the order the same on every run.
 * - A playlist is a named list of songs with a cover: the sprite of its most popular song,
 *   like the cover of an album. "Catalog" is the default: the visitor's own songs, then the
 *   examples in their own order, then the 50 best songs that open in one click (a file of the
 *   repository, a download this browser kept, or a song the file fetcher brings). One playlist
 *   per other collection follows it, named and ordered by the registry
 *   (`data/catalog/collections.json`). A collection of songs that live on another site (MPB, the
 *   biggest) opens into albums, one per artist; a collection of the student's own MIDI files
 *   opens into the albums its songs name, and is sorted as its registry record says. The
 *   examples have no playlist of their own: Catalog shows them first.
 *
 * Everything here is a pure function of the catalog entries, so it is tested without a browser;
 * `ui/song-shelf.js` draws the result.
 */

import { normalize } from "./catalog.js";
import { FALLBACK_COLLECTIONS, playlistIdOf, searchRanked, seedOf } from "./sources.js";

/** @typedef {import("./sources.js").CatalogEntry & {pop?: number}} PlaylistEntry */

/**
 * @typedef {object} Playlist
 * @property {string} id short and stable, so the visitor's choice can be remembered
 * @property {string} name
 * @property {string} subtitle the song count, for example "50 songs"
 * @property {PlaylistEntry[]} songs ordered by popularity
 * @property {PlaylistEntry | null} cover the song whose sprite is the cover
 * @property {Playlist[]} [albums] sub-lists: a remote collection's artists, or a collection's albums
 * @property {true} [pending] a tile for a collection whose file is still loading: no songs and
 *   no count yet
 */

/** How many songs Catalog holds besides the visitor's own songs and the examples. */
export const POPULAR_SIZE = 50;

/** The default playlist. */
export const CATALOG_ID = "catalog";

/** The collection whose songs are shown first in Catalog and have no playlist of their own. */
const EXAMPLES = "examples";

/**
 * The playlist id a remembered choice leads to now: "Popular" and "Examples" were folded into
 * "Catalog", and a visitor who had chosen either lands there.
 *
 * @param {string | null | undefined} id a remembered playlist id, if any
 * @returns {string}
 * @example
 * playlistAlias("popular"); // "catalog"
 * playlistAlias("mpb"); // "mpb"
 */
export function playlistAlias(id) {
  return !id || id === "popular" || id === "examples" ? CATALOG_ID : id;
}

/** An artist needs this many songs to have an album of their own. */
export const ALBUM_MIN_SONGS = 5;

/** How many artist albums MPB shows; the rest of the songs are reachable by search. */
export const MPB_ALBUM_COUNT = 24;

const collator = new Intl.Collator("pt");

/**
 * How popular a song is; a song with no `pop` counts as 0.
 *
 * @param {PlaylistEntry} entry
 * @returns {number}
 * @example
 * popOf({ id: "a", t: "A", pop: 7 }); // 7
 * popOf({ id: "a", t: "A" }); // 0
 */
export function popOf(entry) {
  return entry.pop ?? 0;
}

/**
 * The songs ordered by popularity, highest first. Ties go to the examples' `order` field, then
 * to the title without accents or letter case, then to the id.
 *
 * @param {PlaylistEntry[]} entries left unchanged
 * @returns {PlaylistEntry[]} a new list
 * @example
 * sortByPopularity([{ id: "a", t: "A", pop: 1 }, { id: "b", t: "B", pop: 9 }]).map((e) => e.id); // ["b", "a"]
 */
export function sortByPopularity(entries) {
  // The title is normalized once per song, not once per comparison: thousands of songs.
  return entries
    .map((entry) => ({ entry, title: normalize(entry.t) }))
    .sort(
      (a, b) =>
        popOf(b.entry) - popOf(a.entry) ||
        (a.entry.order ?? Infinity) - (b.entry.order ?? Infinity) ||
        collator.compare(a.title, b.title) ||
        (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0),
    )
    .map(({ entry }) => entry);
}

/**
 * The whole catalog as the shelf shows it: the visitor's own songs first, in the order given
 * (newest first), then every other song by popularity.
 *
 * @param {PlaylistEntry[]} entries
 * @returns {PlaylistEntry[]}
 * @example
 * orderCatalog([{ id: "x", t: "X", pop: 3 }, { id: "own", t: "Own", source: "local" }]).map((e) => e.id); // ["own", "x"]
 */
export function orderCatalog(entries) {
  return [...entries.filter(isOwn), ...sortByPopularity(entries.filter((entry) => !isOwn(entry)))];
}

/**
 * The songs that match a query, best text match first (title starts with it, then contains it,
 * then composer or performer), and the more popular song first among equal matches.
 *
 * @param {PlaylistEntry[]} entries the catalog, ordered by popularity
 * @param {string} query the visitor's words
 * @returns {PlaylistEntry[]} the catalog itself for a query under 2 letters
 * @example
 * searchByPopularity(catalog, "samba").map((e) => e.t); // title matches first, famous ones first
 */
export function searchByPopularity(entries, query) {
  // The ranks come with the hits, from titles normalized once per list (`searchRanked`): a
  // keystroke does not normalize a thousand titles again.
  const hits = searchRanked(entries, query);
  if (hits === null) return entries;
  // `searchRanked` already breaks ties by title; this sort is stable, so equal rank and equal
  // popularity keep that title order.
  return hits.sort((a, b) => a.rank - b.rank || popOf(b.entry) - popOf(a.entry)).map(({ entry }) => entry);
}

/** @param {PlaylistEntry} entry */
function isOwn(entry) {
  return entry.source === "local";
}

/**
 * Whether one click arranges the song: it reads from a lead sheet or a MIDI file of the
 * repository (`abc`, `tune` or `midi`) and has no error, or it is a download that the page can
 * bring by itself (`isOneClick`: this browser kept the file, or the file fetcher can bring it).
 * Songs that still need the visitor to download a file first do not.
 *
 * @param {PlaylistEntry} entry
 * @param {(entry: PlaylistEntry) => boolean} [isOneClick] whether the page can open the song's
 *   downloadable file without the visitor; default: it cannot
 * @returns {boolean}
 * @example
 * canArrangeInOneClick({ id: "a", t: "A", route: { abc: "abc/a.abc" } }); // true
 * canArrangeInOneClick({ id: "a", t: "A", route: { midi: "../songs/a.mid" } }); // true
 * canArrangeInOneClick({ id: "a", t: "A", route: { download: "https://example.org/a.mid" } }); // false
 * canArrangeInOneClick({ id: "a", t: "A", route: { download: "https://example.org/a.mid" } }, () => true); // true
 */
export function canArrangeInOneClick(entry, isOneClick = () => false) {
  if (entry.error || !entry.route) return false;
  if (entry.route.download !== undefined) return isOneClick(entry);
  return entry.route.abc !== undefined || entry.route.tune !== undefined || entry.route.midi !== undefined;
}

/**
 * Who an album of the song's artist is named after: the performer, or else the first of the
 * composers (the catalog lists composers as "A, B e C").
 *
 * @param {PlaylistEntry} entry
 * @returns {string} "" when the song names nobody
 * @example
 * artistOf({ id: "a", t: "A", p: "Elis Regina", c: "Tom Jobim" }); // "Elis Regina"
 * artistOf({ id: "a", t: "A", p: "", c: "Ary Barroso e Luiz Peixoto" }); // "Ary Barroso"
 */
export function artistOf(entry) {
  const performer = (entry.p ?? "").trim();
  if (performer !== "") return performer;
  return (entry.c ?? "").split(/\s+e\s+|\s+and\s+|\s+&\s+|\s+\/\s+|[,;]/)[0].trim();
}

/**
 * @param {number} count
 * @returns {string} "1 song" or "12 songs"
 */
function songCount(count) {
  return `${count.toLocaleString("en")} ${count === 1 ? "song" : "songs"}`;
}

/**
 * @param {string} id
 * @param {string} name
 * @param {PlaylistEntry[]} songs already ordered
 * @param {PlaylistEntry | null} [cover] default: the first song
 * @returns {Playlist}
 */
function makePlaylist(id, name, songs, cover = songs[0] ?? null) {
  return { id, name, subtitle: songCount(songs.length), songs, cover };
}

/**
 * A remote collection as albums: one per artist with at least 5 songs, the most popular artists
 * first (the sum of their songs' popularity), then "Other artists" with every song not in a
 * shown album.
 *
 * @param {string} collectionId the collection's id, which prefixes the album ids
 * @param {PlaylistEntry[]} songs the collection's songs, ordered by popularity
 * @returns {Playlist[]}
 */
function artistAlbums(collectionId, songs) {
  /** @type {Map<string, {name: string, songs: PlaylistEntry[], total: number}>} */
  const byArtist = new Map();
  for (const song of songs) {
    const name = artistOf(song);
    if (name === "") continue;
    const key = normalize(name);
    const artist = byArtist.get(key) ?? { name, songs: [], total: 0 };
    artist.songs.push(song);
    artist.total += popOf(song);
    byArtist.set(key, artist);
  }
  const shown = [...byArtist.entries()]
    .filter(([, artist]) => artist.songs.length >= ALBUM_MIN_SONGS)
    .sort(([, a], [, b]) => b.total - a.total || collator.compare(normalize(a.name), normalize(b.name)))
    .slice(0, MPB_ALBUM_COUNT);
  const albums = shown.map(([key, artist]) => makePlaylist(`${collectionId}-${key}`, artist.name, artist.songs));
  const inAlbum = new Set(albums.flatMap((album) => album.songs));
  const others = songs.filter((song) => !inAlbum.has(song));
  if (others.length > 0) albums.push(makePlaylist(`${collectionId}-other`, "Other artists", others));
  return albums;
}

/**
 * A collection's songs in the order its registry record asks for.
 *
 * - "popularity" (the default): best known first; equal popularity goes to the `order` number,
 *   then to the title. This is `sortByPopularity`.
 * - "title": the title without accents or letter case.
 * - "order": the `order` numbers; a song without one comes last, by title.
 *
 * @param {PlaylistEntry[]} songs left unchanged
 * @param {string} [sort] "popularity", "title" or "order"
 * @returns {PlaylistEntry[]} a new list
 * @example
 * sortCollection([{ id: "a", t: "B", order: 1 }, { id: "b", t: "A" }], "order").map((e) => e.id); // ["a", "b"]
 */
export function sortCollection(songs, sort = "popularity") {
  if (sort === "popularity") return sortByPopularity(songs);
  return songs
    .map((entry) => ({ entry, title: normalize(entry.t) }))
    .sort(
      (a, b) =>
        (sort === "order" ? (a.entry.order ?? Infinity) - (b.entry.order ?? Infinity) || 0 : 0) ||
        collator.compare(a.title, b.title) ||
        (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0),
    )
    .map(({ entry }) => entry);
}

/**
 * A collection's songs as albums, by the `album` field of each song, in the order of the
 * songs' first appearance in the list; songs with no album go to "Other songs", last.
 *
 * @param {string} collectionId prefixes the album ids
 * @param {PlaylistEntry[]} songs already in the collection's order
 * @returns {Playlist[] | undefined} undefined when no song has an album, or all songs share one
 */
function namedAlbums(collectionId, songs) {
  /** @type {Map<string, {name: string, songs: PlaylistEntry[]}>} */
  const byName = new Map();
  const others = [];
  for (const song of songs) {
    const name = (song.album ?? "").trim();
    if (name === "") {
      others.push(song);
      continue;
    }
    const key = normalize(name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "album";
    const album = byName.get(key) ?? { name, songs: [] };
    album.songs.push(song);
    byName.set(key, album);
  }
  if (byName.size === 0 || (byName.size === 1 && others.length === 0)) return undefined;
  const albums = [...byName.entries()].map(([key, album]) => makePlaylist(`${collectionId}-album-${key}`, album.name, album.songs));
  if (others.length > 0) albums.push(makePlaylist(`${collectionId}-other`, "Other songs", others));
  return albums;
}

/**
 * The playlist of one registered collection.
 *
 * @param {import("./sources.js").CollectionRecord} record
 * @param {PlaylistEntry[]} songs the collection's songs, by popularity (the catalog's order)
 * @param {boolean} isPending whether the collection's file is still to come
 * @returns {Playlist | null} null when there is nothing to show yet
 */
function collectionPlaylist(record, songs, isPending) {
  const id = playlistIdOf(record.id);
  if (songs.length === 0) {
    if (!isPending) return null;
    // No count and no songs yet; the cover is a made-up record, as the real one is not known.
    return {
      id, name: record.name, subtitle: "", songs: [], pending: true,
      cover: { id: record.id, source: record.id, t: record.name, seed: seedOf(record.id, record.id) },
    };
  }
  const ordered = record.kind === "local-midi" ? sortCollection(songs, record.default_sort) : songs;
  const best = ordered.reduce((top, song) => (popOf(song) > popOf(top) ? song : top), ordered[0]);
  const list = makePlaylist(id, record.name, ordered, popOf(best) > 0 ? best : ordered[0]);
  const albums = record.kind === "remote" ? artistAlbums(record.id, ordered) : namedAlbums(record.id, ordered);
  if (albums) {
    const count = albums.filter((album) => !album.id.endsWith("-other")).length;
    list.subtitle = `${songCount(ordered.length)}, ${count} ${count === 1 ? "album" : "albums"}`;
    list.albums = albums;
  }
  return list;
}

/**
 * The playlists of a catalog, in the order the chooser shows them: Catalog, then one per
 * registered collection in the registry's order (by default MPB, Choro & public domain, Folk
 * tunes, and Classical & standards), then Your songs (only when the visitor opened some). The
 * examples collection has no playlist: its songs are in Catalog, first. A playlist with no songs
 * is left out, except that of a lazy collection whose file is still loading: it shows with no
 * count, so the tile does not appear later and shift the others. A disabled collection has no
 * playlist, and neither do songs of a collection nobody registered.
 *
 * @param {PlaylistEntry[]} entries the catalog in any order, with the visitor's own songs
 *   (source "local") in the order they should show
 * @param {{isOneClick?: (entry: PlaylistEntry) => boolean, pending?: string[], collections?: ReadonlyArray<import("./sources.js").CollectionRecord>}} [context]
 *   `isOneClick`: which downloadable songs the page opens by itself (a kept download, a file the
 *   fetcher brings); they join Catalog; `pending`: the collections whose file has not arrived;
 *   `collections`: the registry's records (default: the built-in ones)
 * @returns {Playlist[]}
 * @example
 * buildPlaylists(catalog).map((list) => list.name); // ["Catalog", "MPB", ...]
 */
export function buildPlaylists(entries, { isOneClick = () => false, pending = [], collections = FALLBACK_COLLECTIONS } = {}) {
  const active = collections.filter((record) => record.enabled);
  const known = new Set(active.map((record) => record.id));
  const own = entries.filter(isOwn);
  const rest = sortByPopularity(entries.filter((entry) => !isOwn(entry) && known.has(entry.source ?? "")));
  /** @param {string} source */
  const from = (source) => rest.filter((entry) => entry.source === source);

  const examples = sortCollection(from(EXAMPLES), "order");
  const best = rest.filter((entry) => entry.source !== EXAMPLES && canArrangeInOneClick(entry, isOneClick)).slice(0, POPULAR_SIZE);
  const catalogSongs = [...own, ...examples, ...best];
  const lists = [makePlaylist(CATALOG_ID, "Catalog", catalogSongs, best[0] ?? examples[0] ?? own[0] ?? null)];
  const ordered = active
    .filter((record) => record.id !== EXAMPLES)
    .map((record, position) => ({ record, position }))
    .sort((a, b) => a.record.order - b.record.order || a.position - b.position);
  for (const { record } of ordered) {
    const list = collectionPlaylist(record, from(record.id), pending.includes(record.id));
    if (list) lists.push(list);
  }
  lists.push(makePlaylist("yours", "Your songs", own));
  return lists.filter((list) => list.songs.length > 0 || list.pending);
}
