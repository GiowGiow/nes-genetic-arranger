// Tests for the request handler, with a fake upstream `fetch` and a fake cache so that no
// test touches the network. They read as the Worker's behavior from the app's point of view.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHandler, USER_AGENT } from "../src/index.js";
import { createRateLimiter } from "../src/rules.js";

const PAGES = "https://giowgiow.github.io";
const SONG = "https://www.beakauffmann.com/midi/Garota.mid";
const MIDI_BYTES = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, 0, 96]);

/** A cache that remembers responses by URL, like `caches.default` does. */
function fakeCache() {
  const stored = new Map();
  return {
    stored,
    async match(request) {
      const found = stored.get(request.url);
      return found === undefined ? undefined : found.clone();
    },
    async put(request, response) {
      stored.set(request.url, response.clone());
    },
  };
}

/** A fake `fetch` that answers from a table of URL -> () => Response and records every call. */
function fakeFetch(table) {
  const calls = [];
  async function fetchImpl(url, init = {}) {
    calls.push({ url: String(url), init });
    const answer = table[String(url)];
    if (answer === undefined) return new Response("not found", { status: 404 });
    return answer(init);
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

const midiResponse = () => new Response(MIDI_BYTES, { status: 200, headers: { "content-type": "audio/midi" } });
const redirectTo = (location) => () => new Response(null, { status: 302, headers: { location } });

/** Build a handler plus the pieces a test may want to inspect. */
function setup({ table = { [SONG]: midiResponse }, denylist = [], limit = 100, timeoutMs = 1000 } = {}) {
  const fetchImpl = fakeFetch(table);
  const cache = fakeCache();
  const pending = [];
  const ctx = { waitUntil: (promise) => pending.push(promise) };
  const handler = createHandler({
    fetchImpl,
    cache,
    limiter: createRateLimiter({ limit, windowMs: 60_000, now: () => 0 }),
    denylist,
    timeoutMs,
  });
  const call = async (request) => {
    const response = await handler(request, ctx);
    await Promise.all(pending);
    return response;
  };
  return { call, fetchImpl, cache };
}

function midiRequest(song = SONG, { origin = PAGES, ip = "9.9.9.9", method = "GET" } = {}) {
  const headers = {};
  if (origin !== null) headers.origin = origin;
  if (ip !== null) headers["cf-connecting-ip"] = ip;
  return new Request(`https://nes-arranger-midi.example.workers.dev/midi?url=${encodeURIComponent(song)}`, {
    method,
    headers,
  });
}

// ---- health and preflight -------------------------------------------------------------

test("GET /health answers ok without touching the upstream", async () => {
  const { call, fetchImpl } = setup();
  const response = await call(new Request("https://w.example/health"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(fetchImpl.calls.length, 0);
});

test("a preflight from the Pages origin gets the CORS headers and no body", async () => {
  const { call } = setup();
  const request = new Request("https://w.example/midi?url=x", {
    method: "OPTIONS",
    headers: { origin: PAGES, "access-control-request-method": "GET" },
  });
  const response = await call(request);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), PAGES);
  assert.match(response.headers.get("access-control-allow-methods"), /GET/);
  assert.ok(Number(response.headers.get("access-control-max-age")) > 0);
});

test("a preflight from another origin is refused with 403", async () => {
  const { call } = setup();
  const request = new Request("https://w.example/midi?url=x", {
    method: "OPTIONS",
    headers: { origin: "https://evil.example" },
  });
  const response = await call(request);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

// ---- origin gate ----------------------------------------------------------------------

test("a request from another origin gets 403 and never reaches the upstream", async () => {
  const { call, fetchImpl } = setup();
  const response = await call(midiRequest(SONG, { origin: "https://evil.example" }));
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test("a request without an Origin header gets 403", async () => {
  const { call, fetchImpl } = setup();
  const response = await call(midiRequest(SONG, { origin: null }));
  assert.equal(response.status, 403);
  assert.equal(fetchImpl.calls.length, 0);
});

test("a local development origin is served", async () => {
  const { call } = setup();
  const response = await call(midiRequest(SONG, { origin: "http://localhost:8000" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:8000");
});

test("methods other than GET and OPTIONS get 405, and unknown paths 404", async () => {
  const { call } = setup();
  assert.equal((await call(midiRequest(SONG, { method: "POST" }))).status, 405);
  assert.equal((await call(new Request("https://w.example/other", { headers: { origin: PAGES } }))).status, 404);
});

// ---- a successful fetch ---------------------------------------------------------------

test("a song is returned byte for byte with CORS, credit and cache headers", async () => {
  const { call } = setup();
  const response = await call(midiRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), MIDI_BYTES);
  assert.equal(response.headers.get("access-control-allow-origin"), PAGES);
  assert.match(response.headers.get("vary"), /Origin/i);
  assert.match(response.headers.get("access-control-expose-headers"), /X-Source/i);
  assert.equal(response.headers.get("x-source"), SONG);
  assert.equal(response.headers.get("content-type"), "audio/midi");
  assert.equal(response.headers.get("cache-control"), "public, max-age=86400");
});

test("the upstream is asked politely: project User-Agent, manual redirects, a timeout signal", async () => {
  const { call, fetchImpl } = setup();
  await call(midiRequest());
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, SONG);
  assert.equal(init.redirect, "manual");
  assert.equal(init.headers["User-Agent"], USER_AGENT);
  assert.equal(USER_AGENT, "nes-genetic-arranger (+https://github.com/GiowGiow/nes-genetic-arranger)");
  assert.ok(init.signal instanceof AbortSignal);
});

test("the visitor's cookies and headers are not forwarded upstream", async () => {
  const { call, fetchImpl } = setup();
  const request = midiRequest();
  request.headers.set("cookie", "secret=1");
  await call(request);
  assert.deepEqual(Object.keys(fetchImpl.calls[0].init.headers).map((k) => k.toLowerCase()), ["user-agent"]);
});

// ---- cache ----------------------------------------------------------------------------

test("a second request for the same song is served from the cache", async () => {
  const { call, fetchImpl, cache } = setup();
  const first = await call(midiRequest());
  const second = await call(midiRequest(SONG, { origin: "http://localhost:3000" }));
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(cache.stored.size, 1);
  assert.deepEqual(new Uint8Array(await second.arrayBuffer()), new Uint8Array(await first.arrayBuffer()));
  assert.equal(second.headers.get("access-control-allow-origin"), "http://localhost:3000");
  assert.equal(second.headers.get("x-source"), SONG);
  assert.equal(second.headers.get("cache-control"), "public, max-age=86400");
});

test("the cached copy lives at most 24 hours and carries no CORS header of its own", async () => {
  const { call, cache } = setup();
  await call(midiRequest());
  const [stored] = [...cache.stored.values()];
  assert.equal(stored.headers.get("cache-control"), "public, max-age=86400");
  assert.equal(stored.headers.get("access-control-allow-origin"), null);
});

test("failures are not cached", async () => {
  const { call, cache } = setup({ table: { [SONG]: () => new Response("<html>", { status: 200 }) } });
  assert.equal((await call(midiRequest())).status, 502);
  assert.equal(cache.stored.size, 0);
});

// ---- URL and denylist -----------------------------------------------------------------

test("a missing url parameter, a foreign host and a non-MIDI path get 400 with no fetch", async () => {
  const { call, fetchImpl } = setup();
  const missing = new Request("https://w.example/midi", { headers: { origin: PAGES } });
  assert.equal((await call(missing)).status, 400);
  assert.equal((await call(midiRequest("https://example.com/a.mid"))).status, 400);
  assert.equal((await call(midiRequest("https://www.beakauffmann.com/a.html"))).status, 400);
  assert.equal((await call(midiRequest("http://www.beakauffmann.com/a.mid"))).status, 400);
  assert.equal(fetchImpl.calls.length, 0);
});

test("an error response still carries CORS headers so the app can read the status", async () => {
  const { call } = setup();
  const response = await call(midiRequest("https://example.com/a.mid"));
  assert.equal(response.headers.get("access-control-allow-origin"), PAGES);
  assert.equal((await response.json()).error.length > 0, true);
});

test("a denylisted song gets 451 with no fetch and no cache entry", async () => {
  const { call, fetchImpl, cache } = setup({ denylist: ["/midi/Garota.mid"] });
  const response = await call(midiRequest());
  assert.equal(response.status, 451);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(cache.stored.size, 0);
});

test("a denylisted song is refused even if it is already in the cache", async () => {
  const { call, cache } = setup();
  await call(midiRequest());
  assert.equal(cache.stored.size, 1);
  const denied = setup({ denylist: ["/midi/Garota.mid"] });
  denied.cache.stored.set(new Request(SONG).url, new Response(MIDI_BYTES));
  assert.equal((await denied.call(midiRequest())).status, 451);
});

// ---- redirects ------------------------------------------------------------------------

test("a redirect inside the allow-list is followed", async () => {
  const moved = "https://beakauffmann.com/new/Garota.mid";
  const { call, fetchImpl } = setup({ table: { [SONG]: redirectTo(moved), [moved]: midiResponse } });
  const response = await call(midiRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(fetchImpl.calls.map((c) => c.url), [SONG, moved]);
  assert.equal(response.headers.get("x-source"), SONG);
});

test("a redirect to a host off the list is refused and never fetched", async () => {
  const { call, fetchImpl } = setup({ table: { [SONG]: redirectTo("https://evil.example/a.mid") } });
  const response = await call(midiRequest());
  assert.equal(response.status, 502);
  assert.deepEqual(fetchImpl.calls.map((c) => c.url), [SONG]);
});

test("a redirect to a denylisted URL is refused", async () => {
  const moved = "https://beakauffmann.com/secret/a.mid";
  const { call, fetchImpl } = setup({
    table: { [SONG]: redirectTo(moved), [moved]: midiResponse },
    denylist: ["/secret/"],
  });
  assert.equal((await call(midiRequest())).status, 451);
  assert.equal(fetchImpl.calls.length, 1);
});

test("at most three redirects are followed", async () => {
  const hop = (n) => `https://www.beakauffmann.com/hop${n}.mid`;
  const chain = (hops) => {
    const table = { [SONG]: redirectTo(hop(1)) };
    for (let n = 1; n <= hops; n += 1) {
      table[hop(n)] = n === hops ? midiResponse : redirectTo(hop(n + 1));
    }
    return table;
  };
  assert.equal((await setup({ table: chain(3) }).call(midiRequest())).status, 200);
  const tooMany = setup({ table: chain(4) });
  assert.equal((await tooMany.call(midiRequest())).status, 502);
  assert.equal(tooMany.fetchImpl.calls.length, 4);
});

// ---- upstream failures ----------------------------------------------------------------

test("an upstream 404 is passed on as 404, other upstream errors as 502", async () => {
  const missing = setup({ table: { [SONG]: () => new Response("", { status: 404 }) } });
  assert.equal((await missing.call(midiRequest())).status, 404);
  const broken = setup({ table: { [SONG]: () => new Response("", { status: 500 }) } });
  assert.equal((await broken.call(midiRequest())).status, 502);
});

test("a network error upstream gives 502", async () => {
  const { call } = setup({
    table: {
      [SONG]: () => {
        throw new TypeError("connection reset");
      },
    },
  });
  assert.equal((await call(midiRequest())).status, 502);
});

test("a body that is not MIDI gives 502", async () => {
  const { call } = setup({ table: { [SONG]: () => new Response("<!doctype html>", { status: 200 }) } });
  assert.equal((await call(midiRequest())).status, 502);
});

test("a file whose Content-Length is over 2 MB gives 413 and its body is dropped unread", async () => {
  let cancelled = false;
  const { call } = setup({
    table: {
      [SONG]: () => {
        const body = new ReadableStream({
          cancel() {
            cancelled = true;
          },
        });
        return new Response(body, { status: 200, headers: { "content-length": String(3 * 1024 * 1024) } });
      },
    },
  });
  assert.equal((await call(midiRequest())).status, 413);
  assert.equal(cancelled, true);
});

test("a file that grows past 2 MB while streaming gives 413", async () => {
  const { call, cache } = setup({
    table: {
      [SONG]: () => {
        const block = new Uint8Array(512 * 1024);
        block.set([0x4d, 0x54, 0x68, 0x64]);
        const body = new ReadableStream({
          pull(controller) {
            controller.enqueue(block);
          },
        });
        return new Response(body, { status: 200 });
      },
    },
  });
  assert.equal((await call(midiRequest())).status, 413);
  assert.equal(cache.stored.size, 0);
});

test("a slow upstream gives 504 after the timeout", async () => {
  const { call } = setup({
    timeoutMs: 20,
    table: {
      [SONG]: ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    },
  });
  assert.equal((await call(midiRequest())).status, 504);
});

// ---- rate limit -----------------------------------------------------------------------

test("a client over its quota gets 429 with Retry-After, and others are unaffected", async () => {
  const { call, fetchImpl } = setup({ limit: 2 });
  assert.equal((await call(midiRequest(SONG, { ip: "1.1.1.1" }))).status, 200);
  assert.equal((await call(midiRequest(SONG, { ip: "1.1.1.1" }))).status, 200);
  const refused = await call(midiRequest(SONG, { ip: "1.1.1.1" }));
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("retry-after"), "60");
  assert.equal(refused.headers.get("access-control-allow-origin"), PAGES);
  assert.equal((await call(midiRequest(SONG, { ip: "2.2.2.2" }))).status, 200);
  assert.equal(fetchImpl.calls.length, 1);
});

test("a request from a refused origin does not use up anyone's quota", async () => {
  const { call } = setup({ limit: 1 });
  await call(midiRequest(SONG, { origin: "https://evil.example", ip: "1.1.1.1" }));
  assert.equal((await call(midiRequest(SONG, { ip: "1.1.1.1" }))).status, 200);
});

// ---- the other sites' files -----------------------------------------------------------

const MIDIS101_FILE = "https://www.midis101.com/download/63384-some-band-some-song";
const MUTOPIA_FILE = "https://www.mutopiaproject.org/ftp/Anonymous/Little/Little.mid";

test("files of midis101.com and the Mutopia Project are served like any other, with credit", async () => {
  for (const file of [MIDIS101_FILE, MUTOPIA_FILE]) {
    const { call } = setup({ table: { [file]: midiResponse } });
    const response = await call(midiRequest(file));
    assert.equal(response.status, 200, file);
    assert.equal(response.headers.get("x-source"), file);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), MIDI_BYTES);
  }
});

test("a page of one of those sites is refused even though its host is allowed", async () => {
  const { call, fetchImpl } = setup();
  assert.equal((await call(midiRequest("https://www.midis101.com/free-midi/63384-x"))).status, 400);
  assert.equal(fetchImpl.calls.length, 0);
});

// ---- search endpoints -----------------------------------------------------------------

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const MIDIS101_PAGE = "https://www.midis101.com/search/example%20band";
const MUTOPIA_PAGE = "https://www.mutopiaproject.org/cgibin/make-table.cgi?searchingfor=little";
const htmlResponse = (name) => () => new Response(fixture(name), { status: 200, headers: { "content-type": "text/html" } });

function searchRequest(source, query, { origin = PAGES, ip = "9.9.9.9" } = {}) {
  const headers = { "cf-connecting-ip": ip };
  if (origin !== null) headers.origin = origin;
  const q = query === undefined ? "" : `?q=${encodeURIComponent(query)}`;
  return new Request(`https://w.example/search/${source}${q}`, { headers });
}

test("/search/midis101 answers a short JSON list read from the site's search page", async () => {
  const { call, fetchImpl } = setup({ table: { [MIDIS101_PAGE]: htmlResponse("midis101-search.html") } });
  const response = await call(searchRequest("midis101", "  example   band "));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("access-control-allow-origin"), PAGES);
  const body = await response.json();
  assert.equal(body.source, "midis101");
  assert.equal(body.results.length, 2);
  assert.equal(body.results[0].midi, "https://www.midis101.com/download/1001-example-band-first-song");
  assert.equal(fetchImpl.calls.length, 1, "one request to the site per search");
  assert.equal(fetchImpl.calls[0].init.headers["User-Agent"], USER_AGENT);
});

test("/search/mutopia answers with title, composer, license and file of each piece", async () => {
  const { call } = setup({ table: { [MUTOPIA_PAGE]: htmlResponse("mutopia-search.html") } });
  const body = await (await call(searchRequest("mutopia", "little"))).json();
  assert.equal(body.source, "mutopia");
  assert.deepEqual(body.results.map((r) => [r.title, r.license]), [["Little Test Piece", "Public Domain"]]);
  assert.equal(body.results[0].midi, MUTOPIA_FILE);
});

test("a search is answered from the cache the second time, for a different origin too", async () => {
  const { call, fetchImpl, cache } = setup({ table: { [MIDIS101_PAGE]: htmlResponse("midis101-search.html") } });
  const first = await (await call(searchRequest("midis101", "example band"))).json();
  const second = await call(searchRequest("midis101", "example band", { origin: "http://localhost:3000" }));
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(cache.stored.size, 1);
  assert.equal(second.headers.get("access-control-allow-origin"), "http://localhost:3000");
  assert.deepEqual(await second.json(), first);
});

test("a search with no usable words gets 400 and no request to the site", async () => {
  const { call, fetchImpl } = setup();
  assert.equal((await call(searchRequest("midis101", undefined))).status, 400);
  assert.equal((await call(searchRequest("midis101", "a"))).status, 400);
  assert.equal((await call(searchRequest("mutopia", "x".repeat(200)))).status, 400);
  assert.equal(fetchImpl.calls.length, 0);
});

test("a search from another origin gets 403 and never reaches the site", async () => {
  const { call, fetchImpl } = setup();
  assert.equal((await call(searchRequest("midis101", "example", { origin: "https://evil.example" }))).status, 403);
  assert.equal(fetchImpl.calls.length, 0);
});

test("an unknown search source is 404", async () => {
  const { call } = setup();
  assert.equal((await call(searchRequest("limewire", "example"))).status, 404);
});

test("searches share the rate limit with the files", async () => {
  const { call } = setup({ limit: 2, table: { [SONG]: midiResponse, [MIDIS101_PAGE]: htmlResponse("midis101-search.html") } });
  assert.equal((await call(midiRequest())).status, 200);
  assert.equal((await call(searchRequest("midis101", "example band"))).status, 200);
  assert.equal((await call(searchRequest("midis101", "example band"))).status, 429);
});

test("when the site fails the search answers 502, and nothing is cached", async () => {
  const { call, cache } = setup({ table: { [MIDIS101_PAGE]: () => new Response("", { status: 500 }) } });
  assert.equal((await call(searchRequest("midis101", "example band"))).status, 502);
  assert.equal(cache.stored.size, 0);
});

test("a search page larger than the page cap gets 413", async () => {
  const big = () => new Response("x".repeat(2 * 1024 * 1024), { status: 200 });
  const { call } = setup({ table: { [MIDIS101_PAGE]: big } });
  assert.equal((await call(searchRequest("midis101", "example band"))).status, 413);
});

test("a result whose file is on the denylist is left out of the list", async () => {
  const { call } = setup({
    table: { [MIDIS101_PAGE]: htmlResponse("midis101-search.html") },
    denylist: ["/download/1001-"],
  });
  const body = await (await call(searchRequest("midis101", "example band"))).json();
  assert.deepEqual(body.results.map((r) => r.id), ["1002"]);
});
