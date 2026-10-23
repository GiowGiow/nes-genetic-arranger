// MIDI fetcher: a Cloudflare Worker that lets the static song app open MIDI files that live on
// sites sending no CORS header.
//
// A browser page may only read a cross-origin response if the other site opts in. The MPB
// catalog does not, so the page asks this Worker instead: `GET /midi?url=<file URL>`. The Worker
// fetches the file at the visitor's request and returns the same bytes with the header that
// lets the app's origin read them. It keeps a copy for at most 24 hours in Cloudflare's edge
// cache so that repeated clicks do not hit the site again; nothing is stored permanently.
//
// This file only routes and assembles responses. The policy (who may ask, what may be fetched,
// how big) is in rules.js, the upstream walk in upstream.js, takedowns in denylist.js.
import { DENYLIST } from "./denylist.js";
import {
  MAX_BYTES,
  UPSTREAM_HOSTS,
  checkUpstreamUrl,
  createRateLimiter,
  isAllowedOrigin,
  isDenied,
} from "./rules.js";
import { MAX_QUERY_LENGTH, cleanQuery, midis101SearchUrl, mutopiaSearchUrl, parseMidis101, parseMutopia } from "./search.js";
import { fetchBytes, fetchMidi } from "./upstream.js";

/** Identifies the project to the sites we fetch from, with a way to contact it. */
export const USER_AGENT = "nes-genetic-arranger (+https://github.com/GiowGiow/nes-genetic-arranger)";

const CACHE_SECONDS = 86400;
const CACHE_CONTROL = `public, max-age=${CACHE_SECONDS}`;
const TIMEOUT_MS = 10_000;
/** A search page is HTML of a few tens of kB; one over this is not what we expect. */
const MAX_PAGE_BYTES = 1024 * 1024;
/** A search answer may be reused for an hour: the sites' catalogs change slowly. */
const SEARCH_CACHE_SECONDS = 3600;

/** The search sources: where each searches and how its page is read. */
const SEARCHES = {
  midis101: { url: midis101SearchUrl, parse: parseMidis101 },
  mutopia: { url: mutopiaSearchUrl, parse: parseMutopia },
};
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    // The app reads X-Source to credit the site the file came from.
    "Access-Control-Expose-Headers": "X-Source",
    Vary: "Origin",
  };
}

function jsonResponse(status, body, origin, extra = {}) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra };
  // Errors carry CORS headers too, otherwise the page sees a network error and not the status.
  if (origin !== null) Object.assign(headers, corsHeaders(origin));
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Build the request handler. Everything that touches the outside world is passed in, so tests
 * can use a scripted upstream and an in-memory cache.
 *
 * @param {{fetchImpl: typeof fetch, cache: Cache, limiter: ReturnType<typeof createRateLimiter>,
 *   denylist?: string[], allowedHosts?: string[], timeoutMs?: number, maxBytes?: number}} deps
 * @returns {(request: Request, ctx: {waitUntil: (promise: Promise<unknown>) => void}) => Promise<Response>}
 */
export function createHandler({
  fetchImpl,
  cache,
  limiter,
  denylist = DENYLIST,
  allowedHosts = UPSTREAM_HOSTS,
  timeoutMs = TIMEOUT_MS,
  maxBytes = MAX_BYTES,
}) {
  /**
   * Answer a search: fetch the site's search page once (or take the answer from the cache),
   * read the songs out of it and return them as JSON. The list is filtered by the denylist on
   * the way out, so a takedown applies to cached answers too.
   */
  async function search(source, rawQuery, origin, ctx) {
    const query = cleanQuery(rawQuery);
    if (query === null) {
      return jsonResponse(400, { error: `q must be 2 to ${MAX_QUERY_LENGTH} characters` }, origin);
    }
    const { url, parse } = SEARCHES[source];
    const pageUrl = url(query);
    const cacheKey = new Request(pageUrl.href);
    const answer = (results) =>
      jsonResponse(
        200,
        { source, query, results: results.filter((result) => !isDenied(new URL(result.midi), denylist)) },
        origin,
        { "Cache-Control": `public, max-age=${SEARCH_CACHE_SECONDS}` },
      );

    const cached = await cache.match(cacheKey);
    if (cached !== undefined) return answer((await cached.json()).results);

    const page = await fetchBytes(pageUrl, { fetchImpl, allowedHosts, denylist, timeoutMs, maxBytes: MAX_PAGE_BYTES, userAgent: USER_AGENT });
    if (!page.ok) return jsonResponse(page.status, { error: page.reason }, origin);
    const results = parse(new TextDecoder().decode(page.bytes));
    ctx.waitUntil(
      cache.put(
        cacheKey,
        new Response(JSON.stringify({ source, query, results }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${SEARCH_CACHE_SECONDS}` },
        }),
      ),
    );
    return answer(results);
  }

  return async function handle(request, ctx) {
    const requestUrl = new URL(request.url);
    const origin = request.headers.get("Origin");
    const originAllowed = isAllowedOrigin(origin);
    const echoedOrigin = originAllowed ? origin : null;

    if (request.method === "OPTIONS") {
      if (!originAllowed) return jsonResponse(403, { error: "origin not allowed" }, null);
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(origin),
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Accept, Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (request.method !== "GET") {
      return jsonResponse(405, { error: "method not allowed" }, echoedOrigin, { Allow: "GET, OPTIONS" });
    }

    if (requestUrl.pathname === "/health") return jsonResponse(200, { ok: true }, echoedOrigin);
    const searchSource = /^\/search\/([a-z0-9]+)$/.exec(requestUrl.pathname)?.[1];
    if (requestUrl.pathname !== "/midi" && !(searchSource && Object.hasOwn(SEARCHES, searchSource))) {
      return jsonResponse(404, { error: "not found" }, echoedOrigin);
    }

    // The origin is checked first so that a refused caller costs nobody a rate-limit slot.
    if (!originAllowed) return jsonResponse(403, { error: "origin not allowed" }, null);

    const client = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const turn = limiter.check(client);
    if (!turn.allowed) {
      return jsonResponse(429, { error: "too many requests, try again soon" }, origin, {
        "Retry-After": String(turn.retryAfterSeconds),
      });
    }

    if (searchSource) {
      return search(searchSource, requestUrl.searchParams.get("q"), origin, ctx);
    }

    const verdict = checkUpstreamUrl(requestUrl.searchParams.get("url"), allowedHosts);
    if (!verdict.ok) return jsonResponse(verdict.status, { error: verdict.reason }, origin);
    const upstreamUrl = verdict.url;

    // Before the cache, so that a takedown takes effect even for a file already cached.
    if (isDenied(upstreamUrl, denylist)) {
      return jsonResponse(451, { error: "song removed on request" }, origin);
    }

    const cacheKey = new Request(upstreamUrl.href);
    const cached = await cache.match(cacheKey);
    if (cached !== undefined) return withCors(cached, origin);

    const result = await fetchMidi(upstreamUrl, {
      fetchImpl,
      allowedHosts,
      denylist,
      timeoutMs,
      maxBytes,
      userAgent: USER_AGENT,
    });
    if (!result.ok) return jsonResponse(result.status, { error: result.reason }, origin);

    const fileHeaders = {
      "Content-Type": "audio/midi",
      "Cache-Control": CACHE_CONTROL,
      "X-Source": upstreamUrl.href,
    };
    ctx.waitUntil(cache.put(cacheKey, new Response(result.bytes, { status: 200, headers: fileHeaders })));
    return new Response(result.bytes, { status: 200, headers: { ...fileHeaders, ...corsHeaders(origin) } });
  };
}

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(origin))) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

// Per-isolate state: the rate limiter lives as long as this isolate does (best effort).
let handler = null;

export default {
  /**
   * Cloudflare entry point.
   * @param {Request} request
   * @param {unknown} env bindings (none are used)
   * @param {{waitUntil: (promise: Promise<unknown>) => void}} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    handler ??= createHandler({
      fetchImpl: (...args) => fetch(...args),
      cache: caches.default,
      limiter: createRateLimiter({ limit: RATE_LIMIT, windowMs: RATE_WINDOW_MS, now: () => Date.now() }),
    });
    return handler(request, ctx);
  },
};
