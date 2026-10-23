// Tests for the pure rules of the MIDI fetcher. Each test name states one rule, so the file
// reads as the Worker's security policy. No network, no clock: everything is injected.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isAllowedOrigin,
  checkUpstreamUrl,
  checkRedirect,
  isDenied,
  checkContentLength,
  readCapped,
  looksLikeMidi,
  createRateLimiter,
  MAX_BYTES,
} from "../src/rules.js";

const HOSTS = ["www.beakauffmann.com", "beakauffmann.com"];

// ---- origin ---------------------------------------------------------------------------

test("the GitHub Pages origin is allowed", () => {
  assert.equal(isAllowedOrigin("https://giowgiow.github.io"), true);
});

test("localhost and 127.0.0.1 are allowed on any port, over http", () => {
  assert.equal(isAllowedOrigin("http://localhost:8000"), true);
  assert.equal(isAllowedOrigin("http://localhost"), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:5173"), true);
});

test("other origins are refused, including look-alikes", () => {
  for (const origin of [
    "https://evil.example",
    "https://giowgiow.github.io.evil.example",
    "http://giowgiow.github.io",
    "https://giowgiow.github.io/",
    "https://other.github.io",
    "http://localhost.evil.example",
    "http://localhost:80:90",
    "https://localhost:8000",
    "null",
    "",
    undefined,
    null,
  ]) {
    assert.equal(isAllowedOrigin(origin), false, String(origin));
  }
});

// ---- upstream URL ---------------------------------------------------------------------

test("an https URL on an allowed host with a .mid path is accepted", () => {
  const verdict = checkUpstreamUrl("https://www.beakauffmann.com/midi/Garota.mid", HOSTS);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.url.href, "https://www.beakauffmann.com/midi/Garota.mid");
});

test("the .midi extension and upper case are accepted", () => {
  assert.equal(checkUpstreamUrl("https://beakauffmann.com/a/B.MIDI", HOSTS).ok, true);
  assert.equal(checkUpstreamUrl("https://beakauffmann.com/a/B.Mid", HOSTS).ok, true);
});

test("a missing or malformed URL is refused with 400", () => {
  for (const raw of [null, undefined, "", "not a url", "//beakauffmann.com/a.mid", "/a.mid"]) {
    const verdict = checkUpstreamUrl(raw, HOSTS);
    assert.equal(verdict.ok, false, String(raw));
    assert.equal(verdict.status, 400);
  }
});

test("plain http is refused", () => {
  const verdict = checkUpstreamUrl("http://www.beakauffmann.com/a.mid", HOSTS);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 400);
});

test("a host outside the list is refused, including look-alikes", () => {
  for (const raw of [
    "https://example.com/a.mid",
    "https://beakauffmann.com.evil.example/a.mid",
    "https://evilbeakauffmann.com/a.mid",
    "https://www.beakauffmann.com@evil.example/a.mid",
    "https://sub.beakauffmann.com/a.mid",
    "https://127.0.0.1/a.mid",
    "https://localhost/a.mid",
  ]) {
    const verdict = checkUpstreamUrl(raw, HOSTS);
    assert.equal(verdict.ok, false, raw);
    assert.equal(verdict.status, 400, raw);
  }
});

test("credentials and non-default ports in the URL are refused", () => {
  assert.equal(checkUpstreamUrl("https://user:pw@www.beakauffmann.com/a.mid", HOSTS).ok, false);
  assert.equal(checkUpstreamUrl("https://www.beakauffmann.com:8443/a.mid", HOSTS).ok, false);
  assert.equal(checkUpstreamUrl("https://www.beakauffmann.com:443/a.mid", HOSTS).ok, true);
});

test("paths that are not .mid or .midi are refused", () => {
  for (const raw of [
    "https://www.beakauffmann.com/",
    "https://www.beakauffmann.com/page.html",
    "https://www.beakauffmann.com/a.mid.html",
    "https://www.beakauffmann.com/a.mid/",
    "https://www.beakauffmann.com/mid",
  ]) {
    assert.equal(checkUpstreamUrl(raw, HOSTS).ok, false, raw);
  }
});

test("a query string does not make a non-MIDI path pass", () => {
  assert.equal(checkUpstreamUrl("https://www.beakauffmann.com/x.html?f=a.mid", HOSTS).ok, false);
  assert.equal(checkUpstreamUrl("https://www.beakauffmann.com/x.mid?v=2", HOSTS).ok, true);
});

// ---- redirects ------------------------------------------------------------------------

test("a redirect to another allowed host is followed", () => {
  const verdict = checkRedirect(
    "https://beakauffmann.com/new/a.mid",
    "https://www.beakauffmann.com/old/a.mid",
    HOSTS,
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.url.href, "https://beakauffmann.com/new/a.mid");
});

test("a relative redirect resolves against the current URL", () => {
  const verdict = checkRedirect("/new/a.mid", "https://www.beakauffmann.com/old/a.mid", HOSTS);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.url.href, "https://www.beakauffmann.com/new/a.mid");
});

test("a redirect that leaves the host list is refused with 502", () => {
  const verdict = checkRedirect(
    "https://evil.example/a.mid",
    "https://www.beakauffmann.com/old/a.mid",
    HOSTS,
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 502);
});

test("a redirect that downgrades to http is refused", () => {
  const verdict = checkRedirect(
    "http://www.beakauffmann.com/a.mid",
    "https://www.beakauffmann.com/old/a.mid",
    HOSTS,
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 502);
});

test("a redirect without a Location header is refused", () => {
  const verdict = checkRedirect(null, "https://www.beakauffmann.com/a.mid", HOSTS);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 502);
});

// ---- denylist -------------------------------------------------------------------------

test("a URL on the denylist is denied, by full URL or by path prefix", () => {
  const url = new URL("https://www.beakauffmann.com/midi/Secret/song.mid");
  assert.equal(isDenied(url, ["https://www.beakauffmann.com/midi/Secret/song.mid"]), true);
  assert.equal(isDenied(url, ["https://www.beakauffmann.com/midi/Secret/"]), true);
  assert.equal(isDenied(url, ["/midi/Secret/"]), true);
});

test("the denylist ignores case and percent-encoding", () => {
  const url = new URL("https://www.beakauffmann.com/midi/Jo%C3%A3o/Song.MID");
  assert.equal(isDenied(url, ["/midi/joão/"]), true);
  assert.equal(isDenied(url, ["/MIDI/JO%C3%83O/"]), true);
});

test("a URL that matches no denylist entry is not denied", () => {
  const url = new URL("https://www.beakauffmann.com/midi/ok/song.mid");
  assert.equal(isDenied(url, ["/midi/Secret/", "https://beakauffmann.com/midi/ok/song.mid"]), false);
  assert.equal(isDenied(url, []), false);
});

// ---- size -----------------------------------------------------------------------------

test("the cap is 2 MB", () => {
  assert.equal(MAX_BYTES, 2 * 1024 * 1024);
});

test("a Content-Length over the cap is refused with 413", () => {
  const verdict = checkContentLength(String(MAX_BYTES + 1), MAX_BYTES);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 413);
});

test("a Content-Length at or under the cap, or a missing one, passes", () => {
  assert.equal(checkContentLength(String(MAX_BYTES), MAX_BYTES).ok, true);
  assert.equal(checkContentLength("1000", MAX_BYTES).ok, true);
  assert.equal(checkContentLength(null, MAX_BYTES).ok, true);
  assert.equal(checkContentLength("garbage", MAX_BYTES).ok, true);
});

function streamOf(...chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

test("readCapped joins the chunks of a body under the cap", async () => {
  const bytes = await readCapped(streamOf(new Uint8Array([1, 2]), new Uint8Array([3])), 10);
  assert.deepEqual([...bytes], [1, 2, 3]);
});

test("readCapped returns null once the body passes the cap, without reading it all", async () => {
  let pulled = 0;
  const endless = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(100));
    },
  });
  assert.equal(await readCapped(endless, 250), null);
  assert.ok(pulled < 10, `read ${pulled} chunks`);
});

test("readCapped accepts a body of exactly the cap", async () => {
  const bytes = await readCapped(streamOf(new Uint8Array(5), new Uint8Array(5)), 10);
  assert.equal(bytes.length, 10);
});

test("readCapped reads an empty or missing body as zero bytes", async () => {
  assert.equal((await readCapped(streamOf(), 10)).length, 0);
  assert.equal((await readCapped(null, 10)).length, 0);
});

// ---- sniff ----------------------------------------------------------------------------

test("a body that starts with MThd looks like MIDI", () => {
  assert.equal(looksLikeMidi(new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0])), true);
});

test("an HTML page, a short body or an empty body does not look like MIDI", () => {
  const html = new TextEncoder().encode("<!doctype html><html></html>");
  assert.equal(looksLikeMidi(html), false);
  assert.equal(looksLikeMidi(new Uint8Array([0x4d, 0x54, 0x68])), false);
  assert.equal(looksLikeMidi(new Uint8Array(0)), false);
});

// ---- rate limit -----------------------------------------------------------------------

test("the rate limiter lets a client make its quota and refuses the next request", () => {
  let now = 0;
  const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => now });
  assert.equal(limiter.check("1.2.3.4").allowed, true);
  assert.equal(limiter.check("1.2.3.4").allowed, true);
  assert.equal(limiter.check("1.2.3.4").allowed, true);
  const refused = limiter.check("1.2.3.4");
  assert.equal(refused.allowed, false);
  assert.equal(refused.retryAfterSeconds, 60);
});

test("the rate limiter counts each client on its own", () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
  assert.equal(limiter.check("a").allowed, true);
  assert.equal(limiter.check("b").allowed, true);
  assert.equal(limiter.check("a").allowed, false);
});

test("the rate limiter forgets a client when the window ends", () => {
  let now = 0;
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => now });
  assert.equal(limiter.check("a").allowed, true);
  now = 30_000;
  const waiting = limiter.check("a");
  assert.equal(waiting.allowed, false);
  assert.equal(waiting.retryAfterSeconds, 30);
  now = 60_000;
  assert.equal(limiter.check("a").allowed, true);
});

test("the rate limiter drops expired clients so its memory stays bounded", () => {
  let now = 0;
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => now, maxClients: 5 });
  for (let i = 0; i < 5; i += 1) limiter.check(`ip${i}`);
  assert.equal(limiter.size(), 5);
  now = 5000;
  limiter.check("fresh");
  assert.equal(limiter.size(), 1);
});
