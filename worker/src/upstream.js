// Fetching one MIDI file from an allow-listed site, politely and with every limit applied.
//
// A fetch here is a short walk: ask the site, and if it answers with a redirect, check that the
// new address is still allowed before following it (at most three hops). When a real answer
// arrives, check its size while reading it, and check that it starts like a MIDI file. The
// whole walk, redirects and reading included, shares one 10 second timeout.
//
// The network call is injected (`fetchImpl`), so tests can script an upstream without a network.
import { checkContentLength, checkRedirect, isDenied, looksLikeMidi, readCapped } from "./rules.js";

/** Redirects followed before giving up. A few hops cover http->https and www changes. */
export const MAX_REDIRECTS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Fetch a MIDI file and return its bytes, or the HTTP status the Worker should answer with.
 *
 * @param {URL} firstUrl an already validated upstream URL
 * @param {{fetchImpl: typeof fetch, allowedHosts: string[], denylist: string[], timeoutMs: number,
 *   maxBytes: number, userAgent: string}} options
 * @returns {Promise<{ok: true, bytes: Uint8Array} | {ok: false, status: number, reason: string}>}
 * @example
 * // With a scripted upstream that answers 404:
 * // (await fetchMidi(url, {...options})).status // 404
 */
export async function fetchMidi(firstUrl, options) {
  const result = await fetchBytes(firstUrl, options);
  if (!result.ok) return result;
  // A site that answers 200 with an HTML error page at a file address must not be relayed as MIDI.
  if (!looksLikeMidi(result.bytes)) return fail(502, "upstream body is not a MIDI file");
  return result;
}

/**
 * Fetch any allow-listed address (a MIDI file, or a search page to be read) with every limit
 * applied: redirects checked, size capped, one shared timeout. It does not look at what the
 * bytes are; `fetchMidi` adds the MIDI check.
 *
 * @param {URL} firstUrl an already validated upstream URL
 * @param {{fetchImpl: typeof fetch, allowedHosts: string[], denylist: string[], timeoutMs: number,
 *   maxBytes: number, userAgent: string}} options
 * @returns {Promise<{ok: true, bytes: Uint8Array} | {ok: false, status: number, reason: string}>}
 */
export async function fetchBytes(firstUrl, { fetchImpl, allowedHosts, denylist, timeoutMs, maxBytes, userAgent }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url = firstUrl;
    let redirects = 0;
    for (;;) {
      // "manual" hands redirects back to us; the default would follow them to any host.
      // Only the User-Agent is sent: nothing of the visitor's request is forwarded.
      const response = await fetchImpl(url.href, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": userAgent },
        signal: controller.signal,
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel();
        if (redirects >= MAX_REDIRECTS) return fail(502, "too many redirects");
        const verdict = checkRedirect(response.headers.get("location"), url.href, allowedHosts);
        if (!verdict.ok) return verdict;
        if (isDenied(verdict.url, denylist)) return fail(451, "song removed on request");
        url = verdict.url;
        redirects += 1;
        continue;
      }

      if (response.status === 404) {
        await response.body?.cancel();
        return fail(404, "song not found upstream");
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        return fail(502, `upstream answered ${response.status}`);
      }

      const announced = checkContentLength(response.headers.get("content-length"), maxBytes);
      if (!announced.ok) {
        await response.body?.cancel();
        return announced;
      }
      const bytes = await readCapped(response.body, maxBytes);
      if (bytes === null) return fail(413, "file is larger than the size cap");
      return { ok: true, bytes };
    }
  } catch (error) {
    if (controller.signal.aborted) return fail(504, "upstream took too long");
    return fail(502, `upstream fetch failed: ${error?.message ?? error}`);
  } finally {
    clearTimeout(timer);
  }
}

function fail(status, reason) {
  return { ok: false, status, reason };
}
