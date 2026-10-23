// @ts-check
/**
 * Song sources: one catalog built from several song collections, its search and its pages, and
 * the route that loads each song (spec 005, stories 3 to 5, research R8).
 *
 * The visitor sees one catalog, not one shelf per collection. Each collection is a file in
 * `data/catalog/`, written by the command line (`contracts/catalog-files.md`):
 *
 * - `examples.json`: the 8 example lead sheets, shown first, in their own order;
 * - `mpb.json`: Brazilian songs whose MIDI files stay at their site: opening one downloads the
 *   file from there and the visitor drops it into the page (the page cannot read another site's
 *   file, and the site's terms do not let this project keep a copy);
 * - `public-domain.json`, `nottingham.json`, `pdmx.json`: lead sheets committed to the
 *   repository, because their composers died long ago or their license allows it.
 *
 * After the examples, every song is listed from A to Z, comparing titles without accents or
 * letter case. The examples file loads first, so the page shows something at once; the other
 * small files follow in the background. `mpb.json` is 2 MB, far larger than the rest, so it is
 * lazy: it is read only when the visitor needs it (`lazySourcesNeeded`), and the page lists it
 * as "still loading" until then.
 *
 * A search ranks matches as a person scans a list (as `catalog.js` does): titles that start
 * with the words, then titles that contain them, then composers and performers. Results of the
 * The Session's results, when they arrive, are appended after the local ones.
 *
 * Each song carries a route, the one way it loads: a file of the repository, a download of the
 * song's MIDI file from its site, a folk tune site's API read by the browser, or a page to open.
 * Every failure becomes a plain sentence for the visitor, written here rather than taken from
 * the site, so the page never names the site a song comes from (FR-014a).
 */

import { MIN_QUERY_LENGTH, normalize } from "./catalog.js";
import { abcToMidi, tuneToAbc, tuneUrl } from "./thesession.js";

/** The catalog files, examples first; paths are relative to the app folder. */
export const CATALOG_FILES = Object.freeze(
  ["examples", "mpb", "public-domain", "nottingham", "pdmx"].map((source) =>
    Object.freeze({ source, path: `data/catalog/${source}.json` }),
  ),
);

/**
 * The sources whose file is read only when needed: the MPB catalog is 2 MB, the other four files
 * together are under 0.3 MB.
 */
export const LAZY_SOURCES = Object.freeze(["mpb"]);

/** What the page says when a song's file is downloaded from its source and dropped in by hand. */
export const PAGE_MESSAGE =
  "The song's MIDI file is downloading from its source. When it finishes, drop it here or choose it with Open MIDI or ABC.";

/** What Preview says for such a song: nothing is downloaded until the visitor arranges it. */
export const PAGE_PREVIEW_MESSAGE =
  "This song's file comes from its source: choose Arrange to download it, then drop it here.";

/** What the page says when a file of the repository or the tune site cannot be reached. */
export const NETWORK_MESSAGE = "The song could not be loaded. Check your connection and try again.";

/** Plain sentences for the statuses a file of the repository or the tune site answers with. */
const STATUS_MESSAGES = Object.freeze({
  404: "This song is not available.",
  429: "Too many requests in a short time. Wait a minute and try again.",
});

const EXAMPLES = "examples";

/** Small words that stay lowercase inside a title, as Portuguese titles write them. */
const SMALL_WORDS = new Set([
  "a", "à", "ao", "aos", "as", "com", "da", "das", "de", "do", "dos", "e", "em", "na", "nas",
  "no", "nos", "o", "os", "ou", "para", "pra", "pro", "por", "um", "uma",
]);

const collator = new Intl.Collator("pt");

/**
 * @typedef {object} Route how a song loads; exactly one of the kinds below
 * @property {string} [abc] a lead sheet of the repository, path from the repository root
 * @property {number} [tune] which tune of that file, 0 for the first
 * @property {string} [download] the address of the song's MIDI file at its site, which the visitor
 *   saves and drops into the page
 * @property {true} [local] a file the visitor opened in this visit
 * @property {number | string} [thesession] a tune number of the folk tune site
 * @property {number} [setting] which setting of that tune, 0 for the first
 * @property {string} [link] a page to open, for sites that only allow links
 */

/**
 * @typedef {object} Facts analysis facts of a song (data model "Analysis facts")
 * @property {string} [key] for example "C major" or "e- minor"
 * @property {number} [tempo_bpm]
 * @property {string} [meter]
 * @property {number} [n_bars]
 */

/**
 * @typedef {object} CatalogEntry one song record (data model "Catalog entry")
 * @property {string} id unique within its source
 * @property {string} [source]
 * @property {string} t title
 * @property {string} [c] composers
 * @property {string} [p] performer
 * @property {string} [u] page at the source (never shown: FR-014a)
 * @property {string} [license]
 * @property {number} [seed] sprite seed
 * @property {Route} [route]
 * @property {Facts} [facts]
 * @property {string} [error] why the song cannot be arranged; then there is no route
 * @property {string} [variant] "2/3" when a song has several files
 * @property {number} [order] place of an example
 */

import { meterText } from "./meter.js";

/** @typedef {{source: string, entries: CatalogEntry[]}} CatalogFile */

/** @typedef {import("./thesession.js").SearchResult} SearchResult */

/**
 * @typedef {object} EntryRequest where a song's file is and how to read it
 * @property {string} url
 * @property {"abc" | "download" | "thesession" | "link"} kind
 * @property {number} [tune] for "abc": which tune of the file
 * @property {number} [setting] for "thesession": which setting of the tune
 */

/**
 * @typedef {object} OpenedSong a song ready for the input panel
 * @property {"abc" | "midi" | "link"} kind
 * @property {string} name a file name for the song
 * @property {string} [text] the ABC tune, for "abc"
 * @property {Uint8Array} [bytes] the MIDI file, for "midi"
 * @property {string} [url] the page to open, for "link"
 * @property {boolean} [byHand] for "link": the visitor downloads the song's file and drops it in
 */

/**
 * @typedef {object} FetchResponse the part of a `fetch` Response this module reads
 * @property {boolean} ok
 * @property {number} status
 * @property {() => Promise<string>} text
 * @property {() => Promise<any>} json
 * @property {() => Promise<ArrayBuffer>} arrayBuffer
 */

/** @typedef {(url: string) => Promise<FetchResponse>} FetchFunction */

/**
 * Join the catalog files into one list: the examples first, then every other song from A to Z.
 *
 * The examples keep their file order, or their `order` field when they have one. The other
 * songs sort by title without accents or letter case, then by id, so a rerun gives the same
 * list. Each entry gets its file's source when it does not state its own.
 *
 * @param {CatalogFile[]} files the parsed catalog files, in any order
 * @returns {CatalogEntry[]}
 * @example
 * mergeCatalog([{ source: "mpb", entries: [{ id: "b", t: "Você" }, { id: "c", t: "Vamos" }] }])
 *   .map((entry) => entry.id); // ["c", "b"]
 */
export function mergeCatalog(files) {
  const entries = files.flatMap((file) =>
    file.entries.map((entry) => (entry.source ? entry : { ...entry, source: file.source })),
  );
  const examples = entries
    .filter((entry) => entry.source === EXAMPLES)
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || 0);
  const others = entries
    .filter((entry) => entry.source !== EXAMPLES)
    .map((entry) => ({ entry, title: normalize(entry.t) }))
    .sort((a, b) => collator.compare(a.title, b.title) || compareText(a.entry.id, b.entry.id))
    .map(({ entry }) => entry);
  return [...examples, ...others];
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Normalized texts of each catalog list, computed once per list. */
const searchIndexes = new WeakMap();

/**
 * @param {CatalogEntry[]} entries
 * @returns {Array<{entry: CatalogEntry, title: string, text: string}>}
 */
function searchIndex(entries) {
  let index = searchIndexes.get(entries);
  if (!index) {
    index = entries.map((entry) => ({
      entry,
      title: normalize(entry.t),
      text: normalize([entry.t, entry.c ?? "", entry.p ?? ""].join(" ")),
    }));
    searchIndexes.set(entries, index);
  }
  return index;
}

/**
 * The songs whose title, composers or performer contain the query, best matches first.
 *
 * Unlike `catalog.js` `search`, it returns every match, since the shelf pages through them.
 *
 * @param {CatalogEntry[]} entries the catalog
 * @param {string} query the visitor's words
 * @returns {CatalogEntry[]} the matches; the catalog itself for a query under 2 characters
 * @example
 * searchCatalog(catalog, "agua").map((entry) => entry.t); // ["ÁGUA DE LUA"]
 * searchCatalog(catalog, "a") === catalog; // true
 */
export function searchCatalog(entries, query) {
  const wanted = normalize(query);
  if (wanted.length < MIN_QUERY_LENGTH) return entries;
  /** @type {Array<{rank: number, title: string, entry: CatalogEntry}>} */
  const hits = [];
  for (const { entry, title, text } of searchIndex(entries)) {
    if (!text.includes(wanted)) continue;
    const rank = title.startsWith(wanted) ? 0 : title.includes(wanted) ? 1 : 2;
    hits.push({ rank, title, entry });
  }
  hits.sort((a, b) => a.rank - b.rank || collator.compare(a.title, b.title));
  return hits.map((hit) => hit.entry);
}

/**
 * The items of one page.
 *
 * @template T
 * @param {T[]} list
 * @param {number} page 0 for the first page
 * @param {number} perPage
 * @returns {T[]} at most `perPage` items; none past the last page
 * @example
 * pageOf([0, 1, 2, 3, 4], 1, 3); // [3, 4]
 */
export function pageOf(list, page, perPage) {
  return list.slice(page * perPage, (page + 1) * perPage);
}

/**
 * How many pages a list of `total` items takes; at least 1, so "page 1 of 1" shows when empty.
 *
 * @param {number} total
 * @param {number} perPage
 * @returns {number}
 * @example
 * pageCount(31, 9); // 4
 * pageCount(0, 15); // 1
 */
export function pageCount(total, perPage) {
  return Math.max(1, Math.ceil(total / perPage));
}

/**
 * A repository path as the app folder reaches it: the app lives in `arranger/`.
 *
 * @param {string} path
 * @returns {string}
 */
function repositoryUrl(path) {
  return path.startsWith("../") || /^https?:/.test(path) ? path : `../${path}`;
}

/**
 * Where a song's file is and how to read it, from the song's route.
 *
 * @param {CatalogEntry} entry
 * @returns {EntryRequest | null} null for a song that cannot be arranged
 * @example
 * entryRequest({ id: "k", t: "K", route: { abc: "data/leadsheets/korobeiniki.abc", tune: 0 } });
 * // { url: "../data/leadsheets/korobeiniki.abc", kind: "abc", tune: 0 }
 * entryRequest({ id: "a", t: "A", route: { download: "https://example.org/a.mid" } });
 * // { url: "https://example.org/a.mid", kind: "download" }
 */
export function entryRequest(entry) {
  const route = entry.route;
  if (!route || entry.error) return null;
  if (route.abc !== undefined) return { url: repositoryUrl(route.abc), kind: "abc", tune: route.tune ?? 0 };
  if (route.download !== undefined) return { url: route.download, kind: "download" };
  if (route.thesession !== undefined) {
    return { url: tuneUrl(route.thesession), kind: "thesession", setting: route.setting ?? 0 };
  }
  if (route.link !== undefined) return { url: route.link, kind: "link" };
  return null;
}

/**
 * One tune of an ABC file, with the file's header (the text before the first X:), which
 * applies to every tune of the file.
 *
 * @param {string} text an ABC file, possibly a collection of tunes
 * @param {number} index which tune, 0 for the first (as `abc-reader.js` counts them)
 * @returns {string}
 * @throws {RangeError} when the file has no such tune
 * @example
 * tuneText("% header\nX:1\nT:One\nK:C\nC4|\n\nX:2\nT:Two\nK:G\nG4|\n", 1);
 * // "% header\nX:2\nT:Two\nK:G\nG4|\n"
 */
export function tuneText(text, index) {
  const starts = [...text.matchAll(/^X:/gm)].map((match) => /** @type {number} */ (match.index));
  if (starts.length === 0 && index === 0) return text;
  if (index < 0 || index >= starts.length) throw new RangeError(`the file has no tune ${index}`);
  return text.slice(0, starts[0]) + text.slice(starts[index], starts[index + 1] ?? text.length);
}

/**
 * The visitor's sentence for a failed request for a file of the repository or the tune site.
 *
 * @param {number} status the HTTP status
 * @returns {string}
 * @example
 * loadErrorMessage(404); // "This song is not available."
 * loadErrorMessage(500); // "The song could not be loaded (HTTP 500)."
 */
export function loadErrorMessage(status) {
  return STATUS_MESSAGES[/** @type {keyof typeof STATUS_MESSAGES} */ (status)] ?? `The song could not be loaded (HTTP ${status}).`;
}

/**
 * An all-capitals title in title case, keeping small Portuguese words in lowercase. A title
 * that has lowercase letters is kept as written.
 *
 * @param {string} title
 * @returns {string}
 * @example
 * displayTitle("10 MINUTOS LONGE DE VOCÊ"); // "10 Minutos Longe de Você"
 * displayTitle("Ievan Polkka"); // "Ievan Polkka"
 */
export function displayTitle(title) {
  if (/\p{Ll}/u.test(title)) return title;
  return title
    .toLowerCase()
    .split(" ")
    .map((word, i) => (i > 0 && SMALL_WORDS.has(word) ? word : word.replace(/\p{L}/u, (letter) => letter.toUpperCase())))
    .join(" ");
}

/**
 * A file name for a song, from its title, without characters that file names refuse.
 *
 * @param {CatalogEntry} entry
 * @param {string} extension without the dot; "" for none
 * @returns {string}
 */
function fileName(entry, extension) {
  const base = displayTitle(entry.t).replace(/[\\/:*?"<>|]+/g, "-").trim() || entry.id;
  return extension ? `${base}.${extension}` : base;
}

/**
 * Load a song along its route, ready for the input panel.
 *
 * A song with a download route is not fetched: the page cannot read another site's file, so the
 * result is a link the caller downloads, and the visitor drops the saved file into the page.
 *
 * @param {CatalogEntry} entry
 * @param {{fetchFn: FetchFunction, abcjs?: any}} context `fetchFn` is the page's `fetch`; `abcjs`
 *   the ABCJS object, needed by the folk tune site's tunes, which become MIDI (research R10)
 * @returns {Promise<OpenedSong>}
 * @throws {Error} with a sentence for the visitor: the song cannot be arranged, its file could
 *   not be loaded, …
 * @example
 * const song = await openEntry(entry, { fetchFn: fetch, abcjs: ABCJS });
 * inputPanel.readFile(new File([song.text ?? song.bytes], song.name));
 */
export async function openEntry(entry, { fetchFn, abcjs }) {
  const request = entryRequest(entry);
  if (request === null) {
    throw new Error(entry.error ? `This song cannot be arranged (${entry.error}).` : "This song cannot be arranged.");
  }
  if (request.kind === "link") return { kind: "link", name: fileName(entry, ""), url: request.url };
  if (request.kind === "download") return { kind: "link", name: fileName(entry, "mid"), url: request.url, byHand: true };

  /** @type {FetchResponse} */
  let response;
  try {
    response = await fetchFn(request.url);
  } catch {
    throw new Error(NETWORK_MESSAGE);
  }
  if (!response.ok) throw new Error(loadErrorMessage(response.status));

  if (request.kind === "abc") {
    return { kind: "abc", name: fileName(entry, "abc"), text: tuneText(await response.text(), request.tune ?? 0) };
  }
  const abc = tuneToAbc(await response.json(), request.setting ?? 0);
  return { kind: "midi", name: fileName(entry, "mid"), bytes: abcToMidi(abcjs, abc) };
}

/**
 * The id of the record of a file the visitor opened: its first 12 hex digits of SHA-256, so the
 * same file always gets the same record.
 *
 * @param {string} sha256
 * @returns {string}
 */
function localId(sha256) {
  return `local-${sha256.slice(0, 12)}`;
}

/**
 * Whether a record is the song the input panel has loaded.
 *
 * Arranging or previewing the record of the song that is already loaded must not read the song
 * again: a fresh reading starts from the likeliest melody track, the whole song and one part,
 * and would throw away what the visitor chose in the panel, such as the melody track.
 *
 * @param {CatalogEntry} entry the record the visitor acted on
 * @param {{sha256: string, catalogEntry: unknown} | null} input the loaded input; null when
 *   nothing is loaded
 * @returns {boolean}
 * @example
 * isLoadedSong(localEntry({ name: "a.mid", sha256, leadSheet }), { sha256, catalogEntry: null }); // true
 * isLoadedSong(shelfSong, { sha256, catalogEntry: otherShelfSong }); // false
 */
export function isLoadedSong(entry, input) {
  if (input === null) return false;
  const shown = /** @type {CatalogEntry | null} */ (input.catalogEntry);
  if (shown) return shown.source === entry.source && shown.id === entry.id;
  // A file just dropped has no record behind it yet: the record is made from its hash.
  return entry.route?.local === true && entry.id === localId(input.sha256);
}

/**
 * The record of a file the visitor opened, so that it sits on the shelf with the other songs.
 *
 * @param {{name: string, sha256: string, leadSheet: import("./leadsheet.js").LeadSheet}} loaded
 * @returns {CatalogEntry}
 * @example
 * localEntry({ name: "tune.mid", sha256: "ab12cd34…", leadSheet }).route; // { local: true }
 */
export function localEntry({ name, sha256, leadSheet }) {
  const first = leadSheet.bars[0];
  return {
    id: localId(sha256),
    source: "local",
    t: leadSheet.title || name.replace(/\.[^.]+$/, ""),
    c: "Your file",
    license: "your file",
    seed: Number.parseInt(sha256.slice(0, 8), 16),
    route: { local: true },
    facts: {
      key: leadSheet.key,
      tempo_bpm: leadSheet.tempoBpm,
      meter: first ? meterText(first.meter) : "",
      n_bars: leadSheet.bars.length,
    },
  };
}

/**
 * Read one catalog file; null when it is missing or unreachable.
 *
 * @param {FetchFunction} fetchFn
 * @param {string} path
 * @returns {Promise<CatalogFile | null>}
 */
async function readCatalogFile(fetchFn, path) {
  try {
    const response = await fetchFn(path);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {object} LoadedCatalog
 * @property {CatalogEntry[]} entries the songs read so far, merged
 * @property {string[]} missing sources whose file could not be read, in the catalog's order
 * @property {(source: string) => Promise<{entries: CatalogEntry[], missing: string[]}>} loadMore
 *   read a lazy file (`LAZY_SOURCES`) now; resolves with the catalog including it
 */

/**
 * Load the catalog: the examples first, then the other small files together. The lazy files
 * (`LAZY_SOURCES`) wait for `loadMore`.
 *
 * `onUpdate` receives the merged catalog each time it grows: with the examples alone, as soon as
 * they arrive, with the small files, and again when `loadMore` brings a lazy file. A file that
 * is missing or unreachable is skipped and named in `missing`, so the rest of the catalog still
 * works; asking `loadMore` for it again tries once more.
 *
 * `entries` and `missing` describe the catalog when `loadCatalog` resolves; `loadMore` resolves
 * with the later state.
 *
 * @param {FetchFunction} fetchFn the page's `fetch`
 * @param {(entries: CatalogEntry[]) => void} [onUpdate]
 * @returns {Promise<LoadedCatalog>}
 * @example
 * const catalog = await loadCatalog(fetch, (list) => shelf.setEntries(list));
 * await catalog.loadMore("mpb"); // the shelf hears about the 4,000 MPB songs
 */
export async function loadCatalog(fetchFn, onUpdate = () => {}) {
  const [first, ...others] = CATALOG_FILES;
  /** @type {Map<string, CatalogFile | null>} the files read, or null for one that failed */
  const files = new Map();
  /** @type {Map<string, Promise<void>>} the lazy files being read now */
  const reading = new Map();

  /** @returns {{entries: CatalogEntry[], missing: string[]}} */
  const snapshot = () => ({
    entries: mergeCatalog([...files.values()].filter((file) => file !== null)),
    missing: CATALOG_FILES.filter((file) => files.get(file.source) === null).map((file) => file.source),
  });

  files.set(first.source, await readCatalogFile(fetchFn, first.path));
  onUpdate(snapshot().entries);
  const small = others.filter((file) => !LAZY_SOURCES.includes(file.source));
  const loaded = await Promise.all(small.map((file) => readCatalogFile(fetchFn, file.path)));
  small.forEach((file, i) => files.set(file.source, loaded[i]));
  const now = snapshot();
  onUpdate(now.entries);

  /** @param {string} source */
  async function loadMore(source) {
    const file = CATALOG_FILES.find((candidate) => candidate.source === source);
    if (file && LAZY_SOURCES.includes(source) && !files.get(source)) {
      let pending = reading.get(source);
      if (!pending) {
        pending = readCatalogFile(fetchFn, file.path).then((read) => {
          files.set(source, read);
          reading.delete(source);
          if (read) onUpdate(snapshot().entries);
        });
        reading.set(source, pending);
      }
      await pending;
    }
    return snapshot();
  }
  return { ...now, loadMore };
}

/**
 * Which lazy files the visitor's view needs now. The page asks for them (`loadMore`) as soon as
 * this names one, so a file is read when the visitor first gets to something it holds.
 *
 * - The MPB playlist holds only MPB songs.
 * - A search looks through every song, so it needs every lazy file.
 * - A song downloaded on an earlier visit (its key, `source:id`, is in the song cache) is
 *   offered in Popular, which needs the record it belongs to.
 *
 * @param {{playlistId: string | null, searching: boolean, cachedKeys: Iterable<string>}} view
 * @returns {string[]} lazy sources, each once; empty when the small files are enough
 * @example
 * lazySourcesNeeded({ playlistId: "mpb", searching: false, cachedKeys: [] }); // ["mpb"]
 * lazySourcesNeeded({ playlistId: "popular", searching: false, cachedKeys: [] }); // []
 */
export function lazySourcesNeeded({ playlistId, searching, cachedKeys }) {
  const keys = [...cachedKeys];
  return LAZY_SOURCES.filter(
    (source) => searching || playlistId === source || keys.some((key) => key.startsWith(`${source}:`)),
  );
}

/**
 * FNV-1a, a small 32-bit hash: xor each byte of the UTF-8 text in, then multiply by the FNV
 * prime. It gives external songs a stable sprite seed without waiting for SHA-256.
 *
 * @param {string} text
 * @returns {number} an integer from 0 to 2^32 - 1
 * @example
 * fnv1a("a"); // 0xe40c292c, a published test vector
 */
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The sprite seed of a song found by an external search: FNV-1a of `source:id`.
 *
 * Catalog files store SHA-256-based seeds (`src/catalog/cards.py`); external results arrive
 * without one, and the same song must still get the same sprite every time.
 *
 * @param {string} source
 * @param {string} id
 * @returns {number}
 * @example
 * seedOf("web", "123") === fnv1a("web:123"); // true
 */
export function seedOf(source, id) {
  return fnv1a(`${source}:${id}`);
}

/**
 * A search result of an external site, as a catalog entry the shelf can show.
 *
 * @param {SearchResult} result
 * @returns {CatalogEntry}
 * @example
 * externalEntry({ source: "thesession", id: "5", title: "Tune", composer: "", license: "CC0",
 *   format: "abc", page: "", open: "https://thesession.org/tunes/5?format=json" }).route;
 * // { thesession: "5" }
 */
export function externalEntry(result) {
  /** @type {CatalogEntry} */
  const entry = {
    id: result.id,
    source: result.source,
    t: result.title,
    c: result.composer ?? "",
    license: result.license ?? "",
    seed: seedOf(result.source, result.id),
  };
  if (result.error) return { ...entry, error: result.error };
  return { ...entry, route: { thesession: result.id } };
}

/**
 * Local matches first, then the external results that are not already listed.
 *
 * @param {CatalogEntry[]} local matches from the catalog (`searchCatalog`)
 * @param {Array<SearchResult | CatalogEntry>} external results of the tune site, as it gives
 *   them, or already as entries
 * @returns {CatalogEntry[]}
 * @example
 * mergeSearchResults([a], [resultOfA, resultOfB]); // [a, entry of B]
 */
export function mergeSearchResults(local, external) {
  const seen = new Set(local.map((entry) => `${entry.source}:${entry.id}`));
  const merged = [...local];
  for (const item of external) {
    const entry = "t" in item ? item : externalEntry(item);
    const key = `${entry.source}:${entry.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}
