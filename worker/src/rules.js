// The rules of the MIDI fetcher, as pure functions.
//
// The song app is a static page, and some sites that hold MIDI files send no CORS header, so the
// page cannot read them. This Worker fetches such a file on the visitor's request and hands it
// back with the header the page needs. Because it fetches URLs for strangers, it must be a very
// narrow door: only the app's origins may ask, only allow-listed hosts may be fetched, only
// small MIDI files may come back. Every one of those limits is a function in this file, so the
// policy can be read (and tested) in one place, away from the request handling in index.js.
//
// Nothing here touches the network, the clock or global state; the handler injects them.

/** Largest file the Worker will return, in bytes. A song's MIDI file is a few tens of kB. */
export const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Hosts the Worker may fetch from. Add a host here only after reading its terms of use and its
 * robots.txt, and give it a path rule below when its files are not plain `.mid` paths.
 * BitMidi is not here: its robots.txt disallows /uploads/, and its files carry CORS `*`, so the
 * app reads them from the visitor's own browser.
 */
export const UPSTREAM_HOSTS = [
  "www.beakauffmann.com",
  "beakauffmann.com",
  "www.midis101.com",
  "www.mutopiaproject.org",
];

const PAGES_ORIGIN = "https://giowgiow.github.io";
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/**
 * Tell whether a browser origin may use the Worker: the project's GitHub Pages site, or a
 * local development server. The comparison is exact, so look-alike hosts do not pass.
 *
 * @param {string | null | undefined} origin value of the request's Origin header
 * @returns {boolean}
 * @example
 * isAllowedOrigin("https://giowgiow.github.io"); // true
 * isAllowedOrigin("https://giowgiow.github.io.evil.example"); // false
 */
export function isAllowedOrigin(origin) {
  if (typeof origin !== "string") return false;
  return origin === PAGES_ORIGIN || LOCAL_ORIGIN.test(origin);
}

/** True when a path ends in .mid or .midi, ignoring case and percent-encoding. */
function hasMidiExtension(pathname) {
  const path = safeDecode(pathname).toLowerCase();
  return path.endsWith(".mid") || path.endsWith(".midi");
}

/**
 * Where on a host a MIDI file may be. A host without a rule here accepts any path that ends in
 * .mid or .midi. The sites that serve their files from one folder get a narrower rule, so the
 * Worker cannot be asked for their pages, their API or anything else they have. The rule sees the
 * path as the browser sent it, still percent-encoded, so `..` tricks do not hide in it.
 */
const FILE_PATHS = {
  // midis101.com: /download/<number>-<slug> sends the MIDI bytes, with no extension (checked by hand)
  "www.midis101.com": (pathname) => /^\/download\/\d+-[a-z0-9-]+$/i.test(pathname),
  // Mutopia Project: the ftp area, one folder per piece
  "www.mutopiaproject.org": (pathname) => /^\/ftp\/[^?#]+\.mid$/i.test(pathname) && !pathname.includes(".."),
};

/** @param {string} hostname @param {string} pathname */
function isFilePath(hostname, pathname) {
  const rule = FILE_PATHS[hostname];
  return rule ? rule(pathname) : hasMidiExtension(pathname);
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Check the `url` the visitor asked for. It must be a plain https URL on an allowed host,
 * with no credentials and no unusual port, pointing at a .mid or .midi path.
 *
 * @param {string | null | undefined} raw the decoded `url` query parameter
 * @param {string[]} allowedHosts exact host names that may be fetched
 * @returns {{ok: true, url: URL} | {ok: false, status: number, reason: string}}
 * @example
 * checkUpstreamUrl("https://beakauffmann.com/a.mid", ["beakauffmann.com"]).ok; // true
 * checkUpstreamUrl("http://beakauffmann.com/a.mid", ["beakauffmann.com"]).status; // 400
 */
export function checkUpstreamUrl(raw, allowedHosts) {
  const refuse = (reason) => ({ ok: false, status: 400, reason });
  if (typeof raw !== "string" || raw === "") return refuse("missing url parameter");
  let url;
  try {
    url = new URL(raw);
  } catch {
    return refuse("url is not an absolute URL");
  }
  if (url.protocol !== "https:") return refuse("only https URLs are fetched");
  if (url.username !== "" || url.password !== "") return refuse("credentials in the URL");
  if (url.port !== "") return refuse("only the default https port is allowed");
  if (!allowedHosts.includes(url.hostname)) return refuse("host is not on the allow-list");
  if (!isFilePath(url.hostname, url.pathname)) return refuse("only .mid and .midi paths are fetched");
  return { ok: true, url };
}

/**
 * Check a redirect the upstream answered with. A redirect is the classic way to leave an
 * allow-list, so the target faces the same host and scheme rules as the first URL. The path
 * extension is not re-checked: the content sniff and the size cap guard what comes back.
 *
 * @param {string | null} location the Location header
 * @param {string} currentHref the URL that answered with the redirect (resolves relative targets)
 * @param {string[]} allowedHosts exact host names that may be fetched
 * @returns {{ok: true, url: URL} | {ok: false, status: number, reason: string}}
 * @example
 * checkRedirect("/b.mid", "https://beakauffmann.com/a.mid", ["beakauffmann.com"]).url.href;
 * // "https://beakauffmann.com/b.mid"
 */
export function checkRedirect(location, currentHref, allowedHosts) {
  const refuse = (reason) => ({ ok: false, status: 502, reason });
  if (typeof location !== "string" || location === "") return refuse("redirect without a target");
  let url;
  try {
    url = new URL(location, currentHref);
  } catch {
    return refuse("redirect to an invalid URL");
  }
  if (url.protocol !== "https:") return refuse("redirect to a non-https URL");
  if (url.username !== "" || url.password !== "") return refuse("redirect with credentials");
  if (url.port !== "") return refuse("redirect to an unusual port");
  if (!allowedHosts.includes(url.hostname)) return refuse("redirect leaves the allow-list");
  return { ok: true, url };
}

function normalizeForDenylist(text) {
  return safeDecode(text).toLowerCase();
}

/**
 * Tell whether a URL is on the takedown denylist. An entry is a full URL prefix
 * (`https://host/path/`) or a path prefix on any allowed host (`/path/`). Case and
 * percent-encoding are ignored, so `Jo%C3%A3o` and `João` are the same.
 *
 * @param {URL} url the upstream URL about to be fetched
 * @param {string[]} denylist entries from denylist.js
 * @returns {boolean}
 * @example
 * isDenied(new URL("https://beakauffmann.com/m/x.mid"), ["/m/"]); // true
 */
export function isDenied(url, denylist) {
  const href = normalizeForDenylist(url.href);
  const pathname = normalizeForDenylist(url.pathname);
  return denylist.some((entry) => {
    const wanted = normalizeForDenylist(entry);
    if (wanted === "") return false;
    return wanted.startsWith("/") ? pathname.startsWith(wanted) : href.startsWith(wanted);
  });
}

/**
 * Refuse early when the upstream announces a file larger than the cap. A missing or invalid
 * Content-Length passes here; `readCapped` still counts the bytes that arrive.
 *
 * @param {string | null} contentLength value of the Content-Length header
 * @param {number} maxBytes the cap
 * @returns {{ok: true} | {ok: false, status: number, reason: string}}
 * @example
 * checkContentLength("3000000", MAX_BYTES).status; // 413
 */
export function checkContentLength(contentLength, maxBytes) {
  if (typeof contentLength === "string" && /^\d+$/.test(contentLength)) {
    if (Number(contentLength) > maxBytes) {
      return { ok: false, status: 413, reason: "file is larger than the size cap" };
    }
  }
  return { ok: true };
}

/**
 * Read a body into one array of bytes, stopping as soon as it passes the cap. Counting while
 * reading matters because Content-Length can be missing or wrong.
 *
 * @param {ReadableStream<Uint8Array> | null} body
 * @param {number} maxBytes the cap
 * @returns {Promise<Uint8Array | null>} the bytes, or null when the body is over the cap
 * @example
 * (await readCapped(null, 10)).length; // 0
 */
export async function readCapped(body, maxBytes) {
  if (body === null || body === undefined) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * Tell whether bytes look like a Standard MIDI File: they start with the "MThd" header chunk.
 * This stops the Worker from relaying an HTML error page that happens to be served at a .mid URL.
 *
 * @param {Uint8Array} bytes
 * @returns {boolean}
 * @example
 * looksLikeMidi(new Uint8Array([0x4d, 0x54, 0x68, 0x64])); // true
 */
export function looksLikeMidi(bytes) {
  return (
    bytes.length >= 4 && bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64
  );
}

/**
 * A fixed-window rate limiter that keeps its counts in memory. Best effort: a Worker runs in
 * many isolates, each with its own memory, and an isolate can restart at any time, so this slows
 * down a script that hammers the Worker but is not a strict quota.
 *
 * @param {{limit: number, windowMs: number, now: () => number, maxClients?: number}} options
 *   `now` is injected so tests control the clock; `maxClients` bounds the memory used
 * @returns {{check: (client: string) => {allowed: boolean, retryAfterSeconds: number}, size: () => number}}
 * @example
 * const limiter = createRateLimiter({ limit: 1, windowMs: 60000, now: () => 0 });
 * limiter.check("ip").allowed; // true
 * limiter.check("ip").allowed; // false
 */
export function createRateLimiter({ limit, windowMs, now, maxClients = 5000 }) {
  /** @type {Map<string, {windowStart: number, count: number}>} */
  const clients = new Map();

  function dropExpired(at) {
    for (const [client, entry] of clients) {
      if (at - entry.windowStart >= windowMs) clients.delete(client);
    }
  }

  return {
    check(client) {
      const at = now();
      let entry = clients.get(client);
      if (entry !== undefined && at - entry.windowStart >= windowMs) {
        clients.delete(client);
        entry = undefined;
      }
      if (entry === undefined) {
        if (clients.size >= maxClients) {
          dropExpired(at);
          // Still full of live clients: forget the oldest rather than grow without bound.
          if (clients.size >= maxClients) clients.delete(clients.keys().next().value);
        }
        entry = { windowStart: at, count: 0 };
        clients.set(client, entry);
      }
      entry.count += 1;
      const retryAfterSeconds = Math.ceil((entry.windowStart + windowMs - at) / 1000);
      return { allowed: entry.count <= limit, retryAfterSeconds };
    },
    size: () => clients.size,
  };
}
