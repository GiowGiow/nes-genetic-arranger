// @ts-check
/**
 * MIDI fetcher: how the page asks the Worker for a song's file, so a song on another site opens
 * in one click.
 *
 * A browser page may only read a file from another site if that site sends a CORS header, and
 * the sites the catalog points at (beakauffmann.com, BitMidi, midis101.com, the Mutopia Project)
 * mostly do not. So the visitor used to download the file by hand and give it back to the page.
 * The Worker in `worker/` fetches the file at the visitor's request and sends it on with the
 * header the page needs; this module is the page's side of that: the address to ask, the answer
 * read as a file or as a reason, the Worker's health, and the credit line for the site the file
 * came from.
 *
 * The Worker can be down, or refuse (a rate limit, a takedown, a file that is gone). Then the
 * page falls back to the older flow, download and open by hand, and says why in plain words.
 * `createFetcherHealth` remembers that the Worker failed so the page does not promise one-click
 * songs it cannot deliver for the next minute.
 *
 * Everything takes `fetch` and the clock as parameters, so the tests run on a scripted Worker.
 */

import { MIDI_FETCHER_URL } from "./sources.js";

/** Hosts the Worker serves (the same list as `worker/src/rules.js`, `UPSTREAM_HOSTS`). */
export const FETCHABLE_HOSTS = Object.freeze([
  "www.beakauffmann.com",
  "beakauffmann.com",
  "bitmidi.com",
  "www.midis101.com",
  "www.mutopiaproject.org",
]);

/**
 * Hosts whose files the browser may read itself, because they send `Access-Control-Allow-Origin: *`
 * on them (checked on a BitMidi upload, 2026-10-23). The page asks them directly, which saves a
 * hop, keeps the Worker's quota for the others and keeps the Worker out of a site whose
 * `robots.txt` keeps crawlers out of its files: the visitor's own browser does the fetching. The
 * Worker stays the fallback, for a browser or a network that refuses the direct request.
 */
export const DIRECT_HOSTS = Object.freeze(["bitmidi.com"]);

/** How long the page waits for the Worker to bring one file, in milliseconds. */
export const FETCH_TIMEOUT_MS = 15_000;

/** After a failure that says the Worker is down, how long the page does not count on it. */
export const COOL_DOWN_MS = 60_000;

/**
 * @typedef {"missing" | "removed" | "too-big" | "busy" | "source-down" | "worker-down" | "unreachable" | "not-midi"} FailureKind
 */

/**
 * @typedef {{ok: true, bytes: Uint8Array} | {ok: false, kind: FailureKind, status: number, systemic: boolean}} FetchOutcome
 *   `systemic`: the failure says the Worker itself is down or overloaded, not that this one song
 *   is unavailable
 */

/**
 * The host of a file address, when the address is an https URL.
 *
 * @param {string | undefined} address
 * @returns {string | null}
 */
function httpsHost(address) {
  try {
    const url = new URL(address ?? "");
    return url.protocol === "https:" ? url.hostname : null;
  } catch {
    return null;
  }
}

/**
 * Whether the Worker can bring the song's file: its route is a download from a host the Worker
 * serves, and the song has no error.
 *
 * @param {{route?: {download?: string}, error?: string}} entry
 * @returns {boolean}
 * @example
 * isFetchable({ route: { download: "https://bitmidi.com/uploads/1.mid" } }); // true
 * isFetchable({ route: { download: "https://example.org/a.mid" } }); // false
 */
export function isFetchable(entry) {
  if (entry.error || entry.route?.download === undefined) return false;
  const host = httpsHost(entry.route.download);
  return host !== null && FETCHABLE_HOSTS.includes(host);
}

/**
 * The Worker's address for one file.
 *
 * @param {string} fileUrl the file's address at its site
 * @param {string} [base] the Worker's address
 * @returns {string}
 * @example
 * midiFetchUrl("https://bitmidi.com/uploads/1.mid", "https://w.example");
 * // "https://w.example/midi?url=https%3A%2F%2Fbitmidi.com%2Fuploads%2F1.mid"
 */
export function midiFetchUrl(fileUrl, base = MIDI_FETCHER_URL) {
  return `${base}/midi?url=${encodeURIComponent(fileUrl)}`;
}

/**
 * The Worker's address for a search on a site that has no API of its own.
 *
 * @param {"midis101" | "mutopia"} source
 * @param {string} query the visitor's words
 * @param {string} [base] the Worker's address
 * @returns {string}
 * @example
 * fetcherSearchUrl("midis101", "arctic monkeys", "https://w.example"); // "https://w.example/search/midis101?q=arctic%20monkeys"
 */
export function fetcherSearchUrl(source, query, base = MIDI_FETCHER_URL) {
  return `${base}/search/${source}?q=${encodeURIComponent(query)}`;
}

/**
 * What a Worker status means for the page.
 *
 * @param {number} status
 * @returns {{kind: FailureKind, systemic: boolean}}
 */
function classify(status) {
  if (status === 404 || status === 400) return { kind: "missing", systemic: false };
  if (status === 451) return { kind: "removed", systemic: false };
  if (status === 413) return { kind: "too-big", systemic: false };
  if (status === 429) return { kind: "busy", systemic: true };
  if (status === 502 || status === 504) return { kind: "source-down", systemic: false };
  return { kind: "worker-down", systemic: true };
}

/**
 * Whether bytes start like a Standard MIDI File ("MThd").
 *
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
function startsLikeMidi(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64;
}

/**
 * Read a file straight from its site, for the hosts that allow it.
 *
 * @param {string} fileUrl
 * @param {typeof fetch} fetchFn
 * @param {AbortSignal} signal
 * @returns {Promise<Uint8Array | null>} null when the site refused, was not reachable, or sent something that is not MIDI
 */
async function fetchDirect(fileUrl, fetchFn, signal) {
  try {
    const response = await fetchFn(fileUrl, { signal });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return startsLikeMidi(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Get a song's file: straight from its site when the site lets the browser read it
 * (`DIRECT_HOSTS`), through the Worker otherwise or when the direct request fails.
 *
 * @param {{route?: {download?: string}, error?: string}} entry a song with a download route
 * @param {{fetchFn: typeof fetch, base?: string, timeoutMs?: number}} context
 * @returns {Promise<FetchOutcome>} the bytes, or why not; never throws
 * @example
 * const outcome = await fetchMidiFile(entry, { fetchFn: fetch });
 * if (outcome.ok) reader.read(outcome.bytes);
 */
export async function fetchMidiFile(entry, { fetchFn, base = MIDI_FETCHER_URL, timeoutMs = FETCH_TIMEOUT_MS }) {
  if (!isFetchable(entry)) return { ok: false, kind: "missing", status: 0, systemic: false };
  const fileUrl = /** @type {string} */ (entry.route?.download);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (DIRECT_HOSTS.includes(httpsHost(fileUrl) ?? "")) {
      const direct = await fetchDirect(fileUrl, fetchFn, controller.signal);
      if (direct) return { ok: true, bytes: direct };
    }
    const response = await fetchFn(midiFetchUrl(fileUrl, base), { signal: controller.signal });
    if (!response.ok) return { ok: false, status: response.status, ...classify(response.status) };
    const bytes = new Uint8Array(await response.arrayBuffer());
    // The Worker already checks this; a page that trusts nothing it is sent checks again.
    if (!startsLikeMidi(bytes)) return { ok: false, kind: "not-midi", status: response.status, systemic: false };
    return { ok: true, bytes };
  } catch {
    return { ok: false, kind: "unreachable", status: 0, systemic: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The page's memory of whether the Worker works: after a failure that says it is down, the page
 * does not offer one-click downloads for a while.
 *
 * @param {{now: () => number, coolDownMs?: number}} clock
 * @returns {{isUp: () => boolean, recordFailure: (outcome: {systemic: boolean}) => void, recordSuccess: () => void}}
 * @example
 * const health = createFetcherHealth({ now: Date.now });
 * health.recordFailure({ systemic: true });
 * health.isUp(); // false, for a minute
 */
export function createFetcherHealth({ now, coolDownMs = COOL_DOWN_MS }) {
  let downUntil = -Infinity;
  return {
    isUp: () => now() >= downUntil,
    recordFailure({ systemic }) {
      if (systemic) downUntil = now() + coolDownMs;
    },
    recordSuccess() {
      downUntil = -Infinity;
    },
  };
}

/**
 * A sentence for the visitor when the file could not be brought, ending with what to do.
 *
 * @param {FailureKind} kind
 * @returns {string}
 * @example
 * failureMessage("missing"); // "The source no longer has this file. ..."
 */
export function failureMessage(kind) {
  switch (kind) {
    case "missing":
      return "The source no longer has this file. Try another song.";
    case "removed":
      return "This song was taken off the app on request. Try another song.";
    case "too-big":
      return "This file is too large to fetch here. Download it and open it by hand.";
    case "busy":
      return "Too many songs were fetched in a short time. Wait a minute, or download this one by hand.";
    case "source-down":
      return "The source did not answer for this song. Download it and open it by hand.";
    case "not-midi":
      return "The source sent something that is not a MIDI file. Download it and open it by hand.";
    case "worker-down":
    case "unreachable":
    default:
      return "The song fetcher is not answering. Download the file and open it by hand.";
  }
}

/** Names of the sites the Worker serves, and where their front page is. */
const SITES = Object.freeze(
  /** @type {Record<string, {name: string, home: string}>} */ ({
    "www.beakauffmann.com": { name: "beakauffmann.com", home: "https://www.beakauffmann.com/" },
    "beakauffmann.com": { name: "beakauffmann.com", home: "https://www.beakauffmann.com/" },
    "bitmidi.com": { name: "BitMidi", home: "https://bitmidi.com/" },
    "www.midis101.com": { name: "midis101.com", home: "https://www.midis101.com/" },
    "www.mutopiaproject.org": { name: "the Mutopia Project", home: "https://www.mutopiaproject.org/" },
  }),
);

/**
 * The credit for a song downloaded from a site: "MIDI from beakauffmann.com", linked to the
 * song's page there when the record has one on the same site, to the site's front page if not.
 *
 * @param {{route?: {download?: string}, u?: string}} entry
 * @returns {{text: string, link: string} | null} null for a song that is not a download from a known site
 * @example
 * sourceCredit({ route: { download: "https://bitmidi.com/uploads/1.mid" }, u: "https://bitmidi.com/a-mid" });
 * // { text: "MIDI from BitMidi", link: "https://bitmidi.com/a-mid" }
 */
export function sourceCredit(entry) {
  const host = httpsHost(entry.route?.download);
  const site = host === null ? undefined : SITES[host];
  if (!site) return null;
  const sameSite = httpsHost(entry.u) === host || (httpsHost(entry.u) !== null && SITES[/** @type {string} */ (httpsHost(entry.u))]?.home === site.home);
  return { text: `MIDI from ${site.name}`, link: sameSite && entry.u ? entry.u : site.home };
}
