// @ts-check
// Tests for core/midi-fetcher.js: how the page asks the MIDI fetcher Worker for a song's file,
// when a song counts as one that opens in one click, and what the visitor is told when the
// Worker cannot bring it. The Worker itself is tested in worker/test/; here it is a scripted
// `fetch`.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DIRECT_HOSTS,
  FETCHABLE_HOSTS,
  createFetcherHealth,
  failureMessage,
  fetchMidiFile,
  fetcherSearchUrl,
  isFetchable,
  midiFetchUrl,
  sourceCredit,
} from "../src/core/midi-fetcher.js";
import { MIDI_FETCHER_URL } from "../src/core/sources.js";

const BASE = "https://fetcher.example";
const MPB_FILE = "https://www.beakauffmann.com/mpb_v/som/vamo-embolando.mid";
const MPB_SONG = { id: "vamo", source: "mpb", t: "Vamo", u: "https://www.beakauffmann.com/mpb_v/vamo-embolando.html", route: { download: MPB_FILE } };
const MIDI_BYTES = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6]);

/** A fetch that answers every call with `answer` and records the calls. @param {() => Response | Promise<Response>} answer */
function scripted(answer) {
  /** @type {Array<{url: string, init: any}>} */
  const calls = [];
  const fetchFn = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, init });
    return answer();
  };
  return { fetchFn: /** @type {any} */ (fetchFn), calls };
}

test("the Worker's address is the one deployed, with no trailing slash", () => {
  assert.equal(MIDI_FETCHER_URL, "https://nes-arranger-midi.vitorchibento.workers.dev");
});

test("the hosts the page may ask the Worker for are the five the Worker serves", () => {
  assert.deepEqual([...FETCHABLE_HOSTS].sort(), ["beakauffmann.com", "bitmidi.com", "www.beakauffmann.com", "www.midis101.com", "www.mutopiaproject.org"]);
});

test("a song with a download route on a host the Worker serves is fetchable; others are not", () => {
  assert.equal(isFetchable(MPB_SONG), true);
  assert.equal(isFetchable({ ...MPB_SONG, route: { download: "https://bitmidi.com/uploads/1.mid" } }), true);
  assert.equal(isFetchable({ ...MPB_SONG, route: { download: "https://example.org/a.mid" } }), false);
  assert.equal(isFetchable({ ...MPB_SONG, route: { download: "http://www.beakauffmann.com/a.mid" } }), false, "https only");
  assert.equal(isFetchable({ ...MPB_SONG, route: { abc: "x.abc" } }), false);
  assert.equal(isFetchable({ ...MPB_SONG, route: undefined }), false);
  assert.equal(isFetchable({ ...MPB_SONG, error: "broken" }), false);
  assert.equal(isFetchable({ ...MPB_SONG, route: { download: "not a url" } }), false);
});

test("the request to the Worker carries the file's address, encoded", () => {
  assert.equal(midiFetchUrl("https://bitmidi.com/uploads/16424.mid", BASE), `${BASE}/midi?url=https%3A%2F%2Fbitmidi.com%2Fuploads%2F16424.mid`);
});

test("the search requests to the Worker carry the source and the words, encoded", () => {
  assert.equal(fetcherSearchUrl("midis101", "arctic monkeys & co", BASE), `${BASE}/search/midis101?q=arctic%20monkeys%20%26%20co`);
});

test("fetching a song gives its bytes and asks the Worker once", async () => {
  const { fetchFn, calls } = scripted(() => new Response(MIDI_BYTES, { status: 200, headers: { "x-source": MPB_FILE } }));
  const result = await fetchMidiFile(MPB_SONG, { fetchFn, base: BASE });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.bytes, MIDI_BYTES);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, midiFetchUrl(MPB_FILE, BASE));
});

test("the Worker's refusals become plain reasons, and say whether the Worker as a whole looks down", async () => {
  /** @param {number} status */
  const failure = async (status) => {
    const { fetchFn } = scripted(() => new Response("{}", { status }));
    const result = await fetchMidiFile(MPB_SONG, { fetchFn, base: BASE });
    assert.equal(result.ok, false);
    return /** @type {Extract<typeof result, {ok: false}>} */ (result);
  };
  assert.deepEqual((await failure(404)).kind, "missing");
  assert.equal((await failure(404)).systemic, false, "one song is gone, the Worker works");
  assert.equal((await failure(451)).kind, "removed");
  assert.equal((await failure(413)).kind, "too-big");
  assert.equal((await failure(429)).kind, "busy");
  assert.equal((await failure(429)).systemic, true, "asking more would only make it worse");
  assert.equal((await failure(502)).kind, "source-down");
  assert.equal((await failure(502)).systemic, false, "the source failed for this song, the Worker works");
  assert.equal((await failure(504)).kind, "source-down");
  assert.equal((await failure(500)).kind, "worker-down");
  assert.equal((await failure(500)).systemic, true);
  assert.equal((await failure(403)).kind, "worker-down", "a refused origin is a Worker the page cannot use");
});

test("a network failure is a Worker the page cannot reach", async () => {
  const fetchFn = /** @type {any} */ (async () => {
    throw new TypeError("Failed to fetch");
  });
  const result = await fetchMidiFile(MPB_SONG, { fetchFn, base: BASE });
  assert.deepEqual(result, { ok: false, kind: "unreachable", status: 0, systemic: true });
});

test("a body that is not a MIDI file is refused, even from a Worker that answered 200", async () => {
  const { fetchFn } = scripted(() => new Response("<html>", { status: 200 }));
  const result = await fetchMidiFile(MPB_SONG, { fetchFn, base: BASE });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "not-midi");
});

test("a song the Worker does not serve is not asked for at all", async () => {
  const { fetchFn, calls } = scripted(() => new Response(MIDI_BYTES));
  const result = await fetchMidiFile({ ...MPB_SONG, route: { download: "https://example.org/a.mid" } }, { fetchFn, base: BASE });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test("a slow Worker is given up on after the timeout, which counts as unreachable", async () => {
  const fetchFn = /** @type {any} */ (
    (/** @type {string} */ _url, /** @type {any} */ init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
  );
  const result = await fetchMidiFile(MPB_SONG, { fetchFn, base: BASE, timeoutMs: 10 });
  assert.equal(result.ok === false && result.kind, "unreachable");
});

// --- The Worker's health --------------------------------------------------------------------

test("after a failure that says the Worker is down, the page does not count on it for a while", () => {
  let now = 0;
  const health = createFetcherHealth({ now: () => now, coolDownMs: 60_000 });
  assert.equal(health.isUp(), true);
  health.recordFailure({ systemic: false });
  assert.equal(health.isUp(), true, "a missing song does not make the Worker down");
  health.recordFailure({ systemic: true });
  assert.equal(health.isUp(), false);
  now = 59_999;
  assert.equal(health.isUp(), false);
  now = 60_000;
  assert.equal(health.isUp(), true, "it is tried again after the cool-down");
});

test("a success brings the Worker back at once", () => {
  const health = createFetcherHealth({ now: () => 0, coolDownMs: 60_000 });
  health.recordFailure({ systemic: true });
  health.recordSuccess();
  assert.equal(health.isUp(), true);
});

// --- Words for the visitor ------------------------------------------------------------------

test("each failure has a sentence that says what to do next", () => {
  for (const kind of ["missing", "removed", "too-big", "busy", "source-down", "worker-down", "unreachable", "not-midi"]) {
    const text = failureMessage(/** @type {any} */ (kind));
    assert.match(text, /\.$/, kind);
    assert.ok(text.length > 20, kind);
  }
});

// --- Credit ---------------------------------------------------------------------------------

test("the credit names the site the file comes from and links to the song's page there", () => {
  assert.deepEqual(sourceCredit(MPB_SONG), { text: "MIDI from beakauffmann.com", link: MPB_SONG.u });
  assert.deepEqual(sourceCredit({ ...MPB_SONG, u: undefined }), { text: "MIDI from beakauffmann.com", link: "https://www.beakauffmann.com/" });
  assert.equal(sourceCredit({ ...MPB_SONG, route: { download: "https://bitmidi.com/uploads/9.mid" }, u: "https://bitmidi.com/x-mid" })?.text, "MIDI from BitMidi");
  assert.equal(sourceCredit({ ...MPB_SONG, route: { download: "https://www.midis101.com/download/9-x" }, u: undefined })?.text, "MIDI from midis101.com");
  assert.equal(sourceCredit({ ...MPB_SONG, route: { download: "https://www.mutopiaproject.org/ftp/a/b.mid" }, u: undefined })?.text, "MIDI from the Mutopia Project");
});

test("a song that is not downloaded from a site has no credit line", () => {
  assert.equal(sourceCredit({ ...MPB_SONG, route: { abc: "x.abc" } }), null);
  assert.equal(sourceCredit({ ...MPB_SONG, route: { download: "https://example.org/a.mid" } }), null, "a site the page has no name for");
});

test("a page address that is not on the song's own site is not linked", () => {
  assert.equal(sourceCredit({ ...MPB_SONG, u: "https://evil.example/" })?.link, "https://www.beakauffmann.com/");
  assert.equal(sourceCredit({ ...MPB_SONG, u: "javascript:alert(1)" })?.link, "https://www.beakauffmann.com/");
});

// --- Hosts that allow the browser to read their files -----------------------------------------

const BITMIDI_SONG = { id: "7", source: "bitmidi", t: "Found", route: { download: "https://bitmidi.com/uploads/7.mid" } };

test("BitMidi sends a CORS header on its files, so the page reads them itself and the Worker is only the fallback", async () => {
  assert.deepEqual([...DIRECT_HOSTS], ["bitmidi.com"]);
  const { fetchFn, calls } = scripted(() => new Response(MIDI_BYTES, { status: 200 }));
  const result = await fetchMidiFile(BITMIDI_SONG, { fetchFn, base: BASE });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.url), ["https://bitmidi.com/uploads/7.mid"], "one request, to the site, none to the Worker");
});

test("if the browser cannot read a direct file, the Worker is asked", async () => {
  /** @type {string[]} */
  const asked = [];
  const fetchFn = /** @type {any} */ (async (/** @type {string} */ url) => {
    asked.push(url);
    if (url.startsWith("https://bitmidi.com/")) throw new TypeError("Failed to fetch");
    return new Response(MIDI_BYTES, { status: 200 });
  });
  const result = await fetchMidiFile(BITMIDI_SONG, { fetchFn, base: BASE });
  assert.equal(result.ok, true);
  assert.deepEqual(asked, ["https://bitmidi.com/uploads/7.mid", midiFetchUrl("https://bitmidi.com/uploads/7.mid", BASE)]);
});

test("a direct answer that is not MIDI is not trusted: the Worker is asked", async () => {
  /** @type {string[]} */
  const asked = [];
  const fetchFn = /** @type {any} */ (async (/** @type {string} */ url) => {
    asked.push(url);
    return url.startsWith("https://bitmidi.com/") ? new Response("<html>", { status: 200 }) : new Response(MIDI_BYTES, { status: 200 });
  });
  assert.equal((await fetchMidiFile(BITMIDI_SONG, { fetchFn, base: BASE })).ok, true);
  assert.equal(asked.length, 2);
});

test("files of the other sites always go through the Worker", async () => {
  const { fetchFn, calls } = scripted(() => new Response(MIDI_BYTES, { status: 200 }));
  await fetchMidiFile(MPB_SONG, { fetchFn, base: BASE });
  assert.ok(calls.every((call) => call.url.startsWith(BASE)));
});
