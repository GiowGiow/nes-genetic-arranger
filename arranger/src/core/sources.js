// @ts-check
/**
 * Song sources: one catalog built from several song collections, its search and its pages, and
 * the route that loads each song (spec 005, stories 3 to 5, research R8).
 *
 * The visitor sees one catalog, not one shelf per collection. Each collection is a file in
 * `data/catalog/`, written by the command line (`contracts/catalog-files.md`):
 *
 * - `examples.json`: the 8 example lead sheets, shown first, in their own order;
 * - `mpb.json`: Brazilian songs whose MIDI files stay at their site; the project's song server
 *   reduces one to a lead sheet when a visitor opens it;
 * - `public-domain.json`, `nottingham.json`, `pdmx.json`: lead sheets committed to the
 *   repository, because their composers died long ago or their license allows it.
 *
 * After the examples, every song is listed from A to Z, comparing titles without accents or
 * letter case. The examples file loads first, so the page shows something at once; the larger
 * files follow in the background.
 *
 * A search ranks matches as a person scans a list (as `catalog.js` does): titles that start
 * with the words, then titles that contain them, then composers and performers. Results of the
 * external sites, when they arrive, are appended after the local ones.
 *
 * Each song carries a route, the one way it loads: a file of the repository, the song server,
 * a folk tune site's API read by the browser, or a page to open. Every failure becomes a plain
 * sentence for the visitor, written here rather than taken from the server, so the page never
 * names the site a song comes from (FR-014a).
 */

import { MIN_QUERY_LENGTH, normalize } from "./catalog.js";
import { abcToMidi, tuneToAbc, tuneUrl } from "./thesession.js";

/** The catalog files, examples first; paths are relative to the app folder. */
export const CATALOG_FILES = Object.freeze(
  ["examples", "mpb", "public-domain", "nottingham", "pdmx"].map((source) =>
    Object.freeze({ source, path: `data/catalog/${source}.json` }),
  ),
);

/** The song server the published page uses once it is deployed (manifests in `deploy/homelab/`). */
export const PRODUCTION_SERVER = "https://nes-arranger-bh.giow.dev";

/**
 * Whether the production song server is deployed. While it is not, the published page asks it
 * for nothing: an MPB song opens the way it did before the server (its page opens, you download
 * the MIDI file and drop it in) and no other site is searched. Set it to true when the server is up.
 */
export const PRODUCTION_SERVER_LIVE = false;

/** The port of a song server running on the developer's machine (`server/app.py`). */
export const SERVER_PORT = 8765;

/** What the page says when the song server does not answer. */
export const OFFLINE_MESSAGE =
  "The song server is offline, so this song cannot be opened now. Your own files, the examples and arranging still work.";

/** What the page says when a song's file is downloaded from its source and dropped in by hand. */
export const PAGE_MESSAGE =
  "The song's MIDI file is downloading from its source. When it finishes, drop it here or choose it with Open MIDI or ABC.";

/** What Preview says for such a song: nothing is downloaded until the visitor arranges it. */
export const PAGE_PREVIEW_MESSAGE =
  "This song's file comes from its source: choose Arrange to download it, then drop it here.";

/** What the page says when a file of the repository or the tune site cannot be reached. */
export const NETWORK_MESSAGE = "The song could not be loaded. Check your connection and try again.";

/** Plain sentences for the song server's error statuses (`contracts/server-api.md`). */
const STATUS_MESSAGES = Object.freeze({
  404: "This song is not available.",
  409: "This song changed at its source since the catalog was made, so it cannot be opened.",
  413: "This song's file is too large to open.",
  415: "This song's file is not MIDI or ABC, so it cannot be opened.",
  422: "This song cannot be arranged: its file could not be reduced to a lead sheet.",
  429: "Too many requests in a short time. Wait a minute and try again.",
  502: "The song's source did not answer. Try again later.",
  503: "The song server did not answer. Try again later.",
  504: "The song server did not answer. Try again later.",
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
 * @property {string} [server] a path on the song server
 * @property {"abc" | "midi"} [format] what the server path returns (default "abc")
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
 * @property {"abc" | "midi" | "thesession" | "link"} kind
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
 * @property {boolean} [byHand] for "link": the visitor downloads the song's file there and drops it in
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
 * The song server for this page: the developer's own machine when the page is served from it,
 * the production host once it is deployed, nothing before that.
 *
 * @param {{hostname: string}} location the page's `location`
 * @param {boolean} [live] whether the production server is deployed (`PRODUCTION_SERVER_LIVE`)
 * @returns {string | null} the server's origin without a trailing slash; null when there is none
 * @example
 * serverUrl({ hostname: "localhost" }); // "http://localhost:8765"
 * serverUrl({ hostname: "giowgiow.github.io" }, true); // "https://nes-arranger-bh.giow.dev"
 * serverUrl({ hostname: "giowgiow.github.io" }, false); // null
 */
export function serverUrl(location, live = PRODUCTION_SERVER_LIVE) {
  const host = location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return `http://${host}:${SERVER_PORT}`;
  return live ? PRODUCTION_SERVER : null;
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
 * @param {string} server the song server's origin (`serverUrl`)
 * @returns {EntryRequest | null} null for a song that cannot be arranged
 * @example
 * entryRequest({ id: "k", t: "K", route: { abc: "data/leadsheets/korobeiniki.abc", tune: 0 } }, server);
 * // { url: "../data/leadsheets/korobeiniki.abc", kind: "abc", tune: 0 }
 * entryRequest({ id: "a", t: "A", route: { server: "/songs/mpb/a.abc" } }, "http://localhost:8765");
 * // { url: "http://localhost:8765/songs/mpb/a.abc", kind: "abc" }
 */
export function entryRequest(entry, server) {
  const route = entry.route;
  if (!route || entry.error) return null;
  if (route.abc !== undefined) return { url: repositoryUrl(route.abc), kind: "abc", tune: route.tune ?? 0 };
  if (route.server !== undefined) return { url: server + route.server, kind: route.format ?? "abc" };
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
 * The visitor's sentence for a failed request to the song server.
 *
 * @param {number} status the HTTP status
 * @returns {string}
 * @example
 * loadErrorMessage(409); // "This song changed at its source since the catalog was made, so it cannot be opened."
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
 * @param {CatalogEntry} entry
 * @param {{fetchFn: FetchFunction, server: string | null, abcjs?: any}} context `fetchFn` is the
 *   page's `fetch`; `server` the song server (`serverUrl`, null when there is none); `abcjs` the ABCJS object, needed by the
 *   folk tune site's tunes, which become MIDI (research R10)
 * @returns {Promise<OpenedSong>}
 * @throws {Error} with a sentence for the visitor: the server is offline, the song changed at
 *   its source, it cannot be arranged, …
 * @example
 * const song = await openEntry(entry, { fetchFn: fetch, server: serverUrl(location), abcjs: ABCJS });
 * inputPanel.readFile(new File([song.text ?? song.bytes], song.name));
 */
export async function openEntry(entry, { fetchFn, server, abcjs }) {
  const needsServer = entry.route?.server !== undefined;
  if (needsServer && server === null) return pageLink(entry);
  const request = entryRequest(entry, server ?? "");
  if (request === null) {
    throw new Error(entry.error ? `This song cannot be arranged (${entry.error}).` : "This song cannot be arranged.");
  }
  if (request.kind === "link") return { kind: "link", name: fileName(entry, ""), url: request.url };

  /** @type {FetchResponse} */
  let response;
  try {
    response = await fetchFn(request.url);
  } catch {
    if (needsServer) return pageLink(entry);
    throw new Error(NETWORK_MESSAGE);
  }
  if (needsServer && (entry.u || entry.facts?.midi) && [502, 503, 504].includes(response.status)) return pageLink(entry);
  if (!response.ok) throw new Error(loadErrorMessage(response.status));

  if (request.kind === "abc") {
    return { kind: "abc", name: fileName(entry, "abc"), text: tuneText(await response.text(), request.tune ?? 0) };
  }
  if (request.kind === "midi") {
    return { kind: "midi", name: fileName(entry, "mid"), bytes: new Uint8Array(await response.arrayBuffer()) };
  }
  const abc = tuneToAbc(await response.json(), request.setting ?? 0);
  return { kind: "midi", name: fileName(entry, "mid"), bytes: abcToMidi(abcjs, abc) };
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
    id: `local-${sha256.slice(0, 12)}`,
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
 * The way songs opened before the song server: the song's MIDI file is downloaded straight from
 * its source (its own page when the file's address is not known) and the visitor drops it in.
 * Used when the server is not deployed, does not answer, or its source is down.
 *
 * @param {CatalogEntry} entry
 * @returns {OpenedSong}
 * @throws {Error} the offline sentence, for a song that has no page of its own
 */
function pageLink(entry) {
  if (!entry.u && !entry.facts?.midi) throw new Error(OFFLINE_MESSAGE);
  return { kind: "link", name: fileName(entry, "mid"), url: entry.facts?.midi || entry.u, byHand: true };
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
 * Load the catalog: the examples first, then the other files together.
 *
 * `onUpdate` receives the merged catalog twice: with the examples alone, as soon as they
 * arrive, and with every file. A file that is missing or unreachable is skipped and named in
 * `missing`, so the rest of the catalog still works.
 *
 * @param {FetchFunction} fetchFn the page's `fetch`
 * @param {(entries: CatalogEntry[]) => void} [onUpdate]
 * @returns {Promise<{entries: CatalogEntry[], missing: string[]}>} `missing` lists sources
 * @example
 * const { entries, missing } = await loadCatalog(fetch, (list) => shelf.setEntries(list));
 */
export async function loadCatalog(fetchFn, onUpdate = () => {}) {
  const [first, ...rest] = CATALOG_FILES;
  const loaded = [await readCatalogFile(fetchFn, first.path)];
  onUpdate(mergeCatalog(loaded.filter((file) => file !== null)));
  loaded.push(...(await Promise.all(rest.map((file) => readCatalogFile(fetchFn, file.path)))));
  const entries = mergeCatalog(loaded.filter((file) => file !== null));
  onUpdate(entries);
  const missing = CATALOG_FILES.filter((_, i) => loaded[i] === null).map((file) => file.source);
  return { entries, missing };
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
 * externalEntry({ source: "web", id: "5", title: "Tune", composer: "", license: "CC0",
 *   format: "midi", page: "", open: "/files/web/5" }).route; // { server: "/files/web/5", format: "midi" }
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
  if (result.format === "link") return { ...entry, route: { link: result.open } };
  if (result.source === "thesession") return { ...entry, route: { thesession: result.id } };
  return { ...entry, route: { server: result.open, format: result.format } };
}

/**
 * Local matches first, then the external results that are not already listed.
 *
 * @param {CatalogEntry[]} local matches from the catalog (`searchCatalog`)
 * @param {Array<SearchResult | CatalogEntry>} external results of the external sites, as the
 *   server or the tune site give them, or already as entries
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
