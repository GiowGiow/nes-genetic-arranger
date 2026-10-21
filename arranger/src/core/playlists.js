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
 *   like the cover of an album. "Popular" holds the 50 best songs that open in one click.
 *   One playlist per collection follows it, and "MPB", the biggest collection, opens into
 *   albums, one per artist.
 *
 * Everything here is a pure function of the catalog entries, so it is tested without a browser;
 * `ui/song-shelf.js` draws the result.
 */

import { MIN_QUERY_LENGTH, normalize } from "./catalog.js";
import { searchCatalog } from "./sources.js";

/** @typedef {import("./sources.js").CatalogEntry & {pop?: number}} PlaylistEntry */

/**
 * @typedef {object} Playlist
 * @property {string} id short and stable, so the visitor's choice can be remembered
 * @property {string} name
 * @property {string} subtitle the song count, for example "50 songs"
 * @property {PlaylistEntry[]} songs ordered by popularity
 * @property {PlaylistEntry | null} cover the song whose sprite is the cover
 * @property {Playlist[]} [albums] sub-lists; only "MPB" has them
 */

/** How many songs "Popular" holds. */
export const POPULAR_SIZE = 50;

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
  const wanted = normalize(query);
  if (wanted.length < MIN_QUERY_LENGTH) return entries;
  const rankOf = (/** @type {PlaylistEntry} */ entry) => {
    const title = normalize(entry.t);
    return title.startsWith(wanted) ? 0 : title.includes(wanted) ? 1 : 2;
  };
  // `searchCatalog` already ranks and breaks ties by title; sorting its result again is stable,
  // so equal rank and equal popularity keep that title order.
  return searchCatalog(entries, query)
    .map((entry) => ({ entry, rank: rankOf(entry) }))
    .sort((a, b) => a.rank - b.rank || popOf(b.entry) - popOf(a.entry))
    .map(({ entry }) => entry);
}

/** @param {PlaylistEntry} entry */
function isOwn(entry) {
  return entry.source === "local";
}

/**
 * Whether one click arranges the song: it reads from a lead sheet of the repository (`abc` or
 * `tune`) and has no error. Songs that need the visitor to download a file first do not.
 *
 * @param {PlaylistEntry} entry
 * @returns {boolean}
 * @example
 * canArrangeInOneClick({ id: "a", t: "A", route: { abc: "abc/a.abc" } }); // true
 * canArrangeInOneClick({ id: "a", t: "A", route: { download: "https://example.org/a.mid" } }); // false
 */
export function canArrangeInOneClick(entry) {
  if (entry.error || !entry.route) return false;
  return entry.route.abc !== undefined || entry.route.tune !== undefined;
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
 * MPB as albums: one per artist with at least 5 songs, the most popular artists first (the sum
 * of their songs' popularity), then "Other artists" with every song not in a shown album.
 *
 * @param {PlaylistEntry[]} songs the MPB songs, ordered by popularity
 * @returns {Playlist[]}
 */
function mpbAlbums(songs) {
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
  const albums = shown.map(([key, artist]) => makePlaylist(`mpb-${key}`, artist.name, artist.songs));
  const inAlbum = new Set(albums.flatMap((album) => album.songs));
  const others = songs.filter((song) => !inAlbum.has(song));
  if (others.length > 0) albums.push(makePlaylist("mpb-other", "Other artists", others));
  return albums;
}

/**
 * The playlists of a catalog, in the order the chooser shows them: Popular, Your songs (only
 * when the visitor opened some), Examples, MPB, Choro & public domain, Folk tunes, and
 * Classical & standards. A playlist with no songs is left out.
 *
 * @param {PlaylistEntry[]} entries the catalog in any order, with the visitor's own songs
 *   (source "local") in the order they should show
 * @returns {Playlist[]}
 * @example
 * buildPlaylists(catalog).map((list) => list.name); // ["Popular", "Examples", "MPB", ...]
 */
export function buildPlaylists(entries) {
  const own = entries.filter(isOwn);
  const rest = sortByPopularity(entries.filter((entry) => !isOwn(entry)));
  /** @param {string} source */
  const from = (source) => rest.filter((entry) => entry.source === source);

  const best = rest.filter(canArrangeInOneClick).slice(0, POPULAR_SIZE);
  const lists = [
    makePlaylist("popular", "Popular", [...own, ...best], best[0] ?? own[0] ?? null),
    makePlaylist("yours", "Your songs", own),
    makePlaylist("examples", "Examples", from("examples")),
  ];

  const mpbSongs = from("mpb");
  const albums = mpbAlbums(mpbSongs);
  const mpb = makePlaylist("mpb", "MPB", mpbSongs);
  const artistAlbums = albums.filter((album) => album.id !== "mpb-other").length;
  mpb.subtitle = `${songCount(mpbSongs.length)}, ${artistAlbums} ${artistAlbums === 1 ? "album" : "albums"}`;
  mpb.albums = albums;
  lists.push(mpb);

  lists.push(
    makePlaylist("choro", "Choro & public domain", from("public-domain")),
    makePlaylist("folk", "Folk tunes", from("nottingham")),
    makePlaylist("classical", "Classical & standards", from("pdmx")),
  );
  return lists.filter((list) => list.songs.length > 0);
}
