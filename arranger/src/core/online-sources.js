// @ts-check
/**
 * Online sources: the sites the search box asks besides the catalog, so the visitor can find a
 * song the catalog does not have (an international pop song, a piece of Bach).
 *
 * - The Session: folk tunes, read from the browser (its API allows it); the tune is ABC.
 * - BitMidi: a large library of MIDI files uploaded by visitors; its search API allows the
 *   browser, and its files come through the file fetcher.
 * - midis101.com and the Mutopia Project: no API and no CORS header; the file fetcher Worker
 *   reads their search pages (`worker/src/search.js`) and sends back a short JSON list.
 *   Mutopia's pieces are public domain or Creative Commons, with the license named per piece.
 * - IMSLP: a link out to its search page, nothing is fetched (its scores are PDFs).
 *
 * This module knows each site's address and answer: a source is `{id, name, run}` and `run`
 * gives a list of results (`thesession.js` `SearchResult`). `online-search.js` decides when to
 * ask (after a pause, one request per site per query, with a timeout) and keeps the answers.
 * A result becomes a shelf record with `sources.js` `externalEntry`.
 *
 * Honesty about rights: BitMidi and midis101.com do not state a license per file, and the result
 * says so ("Not stated by the site"). The page never keeps these files on a server; it fetches
 * one when the visitor opens it, and the browser keeps it for the visitor's own next visit.
 */

import { FETCHABLE_HOSTS, fetcherSearchUrl } from "./midi-fetcher.js";
import { MIDI_FETCHER_URL } from "./sources.js";
import { searchResults as sessionResults, searchUrl as sessionSearchUrl } from "./thesession.js";

/** @typedef {import("./thesession.js").SearchResult} SearchResult */

/**
 * @typedef {object} OnlineSource
 * @property {string} id also the `source` of its results
 * @property {string} name the name the shelf shows
 * @property {(query: string, context: {signal: AbortSignal}) => Promise<SearchResult[]>} run
 *   search the site; rejects when the site cannot be reached or answers an error
 * @property {(query: string) => SearchResult[]} [instant] for a source that needs no request (a
 *   link out): its results at once, so it never shows as "still being asked"
 */

/** The names the shelf shows for each source, in the order their results are listed. */
export const SOURCE_NAMES = Object.freeze({
  thesession: "The Session",
  bitmidi: "BitMidi",
  midis101: "midis101.com",
  mutopia: "Mutopia Project",
  imslp: "IMSLP",
});

const BITMIDI = "https://bitmidi.com";

/** What a result says about a file whose site gives no license. */
const NO_LICENSE = "Not stated by the site";

/**
 * Where BitMidi's search API is asked: the first 20 results.
 *
 * @param {string} query the visitor's words
 * @returns {string}
 * @example
 * bitmidiSearchUrl("beatles"); // "https://bitmidi.com/api/midi/search?q=beatles&page=0&pageSize=20"
 */
export function bitmidiSearchUrl(query) {
  return `${BITMIDI}/api/midi/search?q=${encodeURIComponent(query)}&page=0&pageSize=20`;
}

/**
 * A BitMidi file name read as a title, and an artist when the name has the form "Artist - Title".
 * File names are what visitors uploaded: "beatles-cant_buy_me_love.mid" becomes
 * "Beatles Cant Buy Me Love".
 *
 * @param {string} fileName
 * @returns {{title: string, composer: string}}
 * @example
 * bitmidiTitle("Ahmed Romel - Only For You.mid"); // { title: "Only For You", composer: "Ahmed Romel" }
 */
export function bitmidiTitle(fileName) {
  const name = fileName.replace(/\.midi?$/i, "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  const split = name.indexOf(" - ");
  if (split > 0) {
    const composer = name.slice(0, split).trim();
    const title = name.slice(split + 3).trim();
    if (title !== "") return { title, composer };
  }
  const words = name
    .replace(/-+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase()));
  return { title: words.join(" ") || "Untitled", composer: "" };
}

/**
 * Read BitMidi's search answer.
 *
 * @param {any} answer the parsed JSON
 * @returns {SearchResult[]} the results with a numeric id; their file is `/uploads/<id>.mid`
 * @example
 * bitmidiResults({ result: { results: [{ id: 5, name: "a.mid", url: "/a-mid" }] } })[0].open; // "https://bitmidi.com/uploads/5.mid"
 */
export function bitmidiResults(answer) {
  const list = answer?.result?.results;
  if (!Array.isArray(list)) return [];
  /** @type {SearchResult[]} */
  const results = [];
  for (const item of list) {
    if (!Number.isInteger(item?.id) || typeof item.name !== "string") continue;
    const { title, composer } = bitmidiTitle(item.name);
    const page = typeof item.url === "string" && item.url.startsWith("/") ? `${BITMIDI}${item.url}` : BITMIDI;
    results.push({
      source: "bitmidi",
      id: String(item.id),
      title,
      composer,
      license: NO_LICENSE,
      format: "midi",
      page,
      open: `${BITMIDI}/uploads/${item.id}.mid`,
    });
  }
  return results;
}

/**
 * Read the file fetcher's answer to a midis101.com or Mutopia search. A result whose file is not
 * on a site the fetcher serves is dropped: the page never builds a request from a stranger's link.
 *
 * @param {"midis101" | "mutopia"} source
 * @param {any} answer the parsed JSON, `{results: [{id, title, url, midi, composer?, license?}]}`
 * @returns {SearchResult[]}
 * @example
 * workerResults("midis101", { results: [{ id: "1", title: "A", url: "https://www.midis101.com/free-midi/1-a", midi: "https://www.midis101.com/download/1-a" }] })[0].title; // "A"
 */
export function workerResults(source, answer) {
  const list = answer?.results;
  if (!Array.isArray(list)) return [];
  /** @type {SearchResult[]} */
  const results = [];
  for (const item of list) {
    if (typeof item?.id !== "string" || typeof item.title !== "string" || typeof item.midi !== "string") continue;
    let host = "";
    try {
      host = new URL(item.midi).hostname;
    } catch {
      continue;
    }
    if (!FETCHABLE_HOSTS.includes(host)) continue;
    results.push({
      source,
      id: item.id,
      title: item.title,
      composer: typeof item.composer === "string" ? item.composer : "",
      license: typeof item.license === "string" && item.license !== "" ? item.license : NO_LICENSE,
      format: "midi",
      page: typeof item.url === "string" ? item.url : "",
      open: item.midi,
    });
  }
  return results;
}

/**
 * IMSLP as a result: a record that opens IMSLP's own search page. IMSLP's scores are PDFs, so
 * nothing is fetched or arranged from it.
 *
 * @param {string} query
 * @returns {SearchResult[]}
 * @example
 * imslpResults("bach")[0].open; // "https://imslp.org/index.php?search=bach&title=Special%3ASearch&fulltext=Search"
 */
export function imslpResults(query) {
  const address = `https://imslp.org/index.php?search=${encodeURIComponent(query)}&title=Special%3ASearch&fulltext=Search`;
  return [
    {
      source: "imslp",
      id: `search-${query}`,
      title: `Search "${query}" on IMSLP`,
      composer: "Scores (PDF), no MIDI",
      license: "See each score",
      format: "link",
      page: address,
      open: address,
    },
  ];
}

/**
 * Ask a JSON address.
 *
 * @param {typeof fetch} fetchFn
 * @param {string} url
 * @param {AbortSignal} signal
 * @returns {Promise<any>}
 * @throws {Error} with the status in the message when the site answers an error
 */
async function getJson(fetchFn, url, signal) {
  const response = await fetchFn(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * The sources, in the order their results are listed.
 *
 * @param {{fetchFn: typeof fetch, workerUrl?: string}} context `workerUrl`: the file fetcher
 * @returns {OnlineSource[]}
 * @example
 * const [theSession, bitMidi] = createOnlineSources({ fetchFn: fetch });
 * const results = await bitMidi.run("beatles", { signal });
 */
export function createOnlineSources({ fetchFn, workerUrl = MIDI_FETCHER_URL }) {
  return [
    { id: "thesession", name: SOURCE_NAMES.thesession, run: async (query, { signal }) => sessionResults(await getJson(fetchFn, sessionSearchUrl(query), signal)) },
    { id: "bitmidi", name: SOURCE_NAMES.bitmidi, run: async (query, { signal }) => bitmidiResults(await getJson(fetchFn, bitmidiSearchUrl(query), signal)) },
    {
      id: "midis101",
      name: SOURCE_NAMES.midis101,
      run: async (query, { signal }) => workerResults("midis101", await getJson(fetchFn, fetcherSearchUrl("midis101", query, workerUrl), signal)),
    },
    {
      id: "mutopia",
      name: SOURCE_NAMES.mutopia,
      run: async (query, { signal }) => workerResults("mutopia", await getJson(fetchFn, fetcherSearchUrl("mutopia", query, workerUrl), signal)),
    },
    { id: "imslp", name: SOURCE_NAMES.imslp, instant: imslpResults, run: async (query) => imslpResults(query) },
  ];
}
