# MIDI fetcher (Cloudflare Worker)

A small Cloudflare Worker that lets the static song app, served from GitHub Pages, open songs
whose MIDI files live on other sites. A browser page may only read a response from another
site if that site sends a CORS header, and the MPB catalog (`www.beakauffmann.com`) does not.
So the page asks this Worker, which fetches the file at the visitor's request and returns the
same bytes with the header the page needs.

Nothing is stored permanently. The Worker keeps a file in Cloudflare's edge cache for at most
24 hours so that repeated clicks do not hit the upstream site again. There is no KV, no R2 and
no database.

## What it does

| Request | Answer |
|---|---|
| `GET /midi?url=<encoded URL>` | The file's bytes (`audio/midi`) with `Access-Control-Allow-Origin` set to the caller's origin, and `X-Source: <upstream URL>` for credit. |
| `GET /search/midis101?q=<words>` | A JSON list read from midis101.com's search page: `{"source": "midis101", "query": "...", "results": [{"id", "title", "url", "midi"}]}` (at most 20; `url` is the song's page, `midi` its file). |
| `GET /search/mutopia?q=<words>` | The same from the Mutopia Project's result list, with `composer`, `instrument` and `license` (public domain or Creative Commons, per piece). Pieces whose MIDI files come only zipped are left out. |
| `GET /health` | `{"ok": true}` |
| `OPTIONS /midi`, `OPTIONS /search/...` | CORS preflight (204). |

Status codes you can see:

| Code | Meaning |
|---|---|
| 400 | Missing or bad `url`: not https, host not on the allow-list, or path not a MIDI file of that host (see Rules). For a search: `q` missing, under 2 or over 80 characters. |
| 403 | Origin not allowed (also when there is no `Origin` header). |
| 404 | Unknown path or search source, or the file does not exist upstream. |
| 413 | File larger than 2 MB (a search page: larger than 1 MB). |
| 429 | More than 30 requests in a minute from one IP (`Retry-After` tells how long). |
| 451 | The song is on the takedown denylist. |
| 502 | Upstream failed, redirected off the allow-list, or sent something that is not MIDI. |
| 504 | Upstream took longer than 10 seconds. |

## Rules

- Who may ask: `https://giowgiow.github.io`, `http://localhost:*` and `http://127.0.0.1:*`.
- What may be fetched: https only, and only these hosts and file paths. Redirects are not
  followed blindly: each hop (at most 3) must stay on the host list.

  | Host | Path of a file |
  |---|---|
  | `www.beakauffmann.com`, `beakauffmann.com` | any path ending in `.mid` or `.midi` |
  | `www.midis101.com` | `/download/<number>-<slug>` (no extension: the site sends the MIDI bytes there; checked by hand on one song, 2026-10-23) |
  | `www.mutopiaproject.org` | `/ftp/.../<file>.mid` |

  The search endpoints fetch one page of search results from midis101.com
  (`/search/<words>`) or the Mutopia Project (`/cgibin/make-table.cgi?searchingfor=<words>`),
  once per search, and keep the answer in the edge cache for an hour. Both sites' `robots.txt`
  allow it. A result is only listed with a file address on the site that was searched.
- BitMidi is not on the list: its `robots.txt` disallows `/uploads/` for crawlers. Its files
  carry `Access-Control-Allow-Origin: *`, so the app reads them straight from the visitor's
  browser, as a visitor's own download.
- What may come back: at most 2 MB (checked on `Content-Length` and again while reading), and
  the body must start with `MThd`.
- Politeness: every upstream request carries the User-Agent
  `nes-genetic-arranger (+https://github.com/GiowGiow/nes-genetic-arranger)`. Nothing from the
  visitor's request (cookies, headers) is forwarded.
- Rate limit: 30 requests per minute per IP, kept in memory per isolate. This is best effort:
  Cloudflare may run several isolates, each with its own count.
- Takedown: add a URL or a path prefix to `src/denylist.js` and redeploy; the Worker then
  answers 451 for it, even if the file is cached, and leaves it out of search results.

The code is split so the policy can be read in one place: `src/rules.js` (pure functions),
`src/upstream.js` (the walk to the upstream), `src/search.js` (search addresses and the readers
of the two search pages), `src/index.js` (routing and responses), `src/denylist.js`. The readers
are tested on small hand-written pages with the same structure (`test/fixtures/`), not on copies
of the sites' pages.

## Deploy

You need a free Cloudflare account and Node.js. From the repository root:

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

`wrangler login` opens a browser to authorize your account. `wrangler deploy` prints the
Worker's address, `https://nes-arranger-midi.<account>.workers.dev`.

Do not route this Worker through the `giow.dev` zone: that zone geoblocks Brazil. The
`wrangler.toml` has no `routes`, so the Worker stays on `workers.dev`, which does not.

Check that it is alive:

```bash
curl https://nes-arranger-midi.<account>.workers.dev/health
```

It should print `{"ok":true}`. To try a song from a terminal, send an allowed Origin header
(replace `<file>` with a real `.mid` path from the catalog):

```bash
curl -s -D - -o /dev/null -H "Origin: https://giowgiow.github.io" \
  "https://nes-arranger-midi.<account>.workers.dev/midi?url=https%3A%2F%2Fwww.beakauffmann.com%2F<file>.mid"
```

Expect `200`, `access-control-allow-origin: https://giowgiow.github.io` and an `x-source` header.

## Tell the app where it is

The app reads the Worker's address from one constant, `MIDI_FETCHER_URL`, in
`arranger/src/core/sources.js`. The main session adds it there; set it to the address that
`wrangler deploy` printed, with no trailing slash:

```js
export const MIDI_FETCHER_URL = "https://nes-arranger-midi.<account>.workers.dev";
```

## Tests

```bash
cd worker
node --test
```

The tests need no network and no wrangler: they inject a scripted `fetch` and an in-memory
cache. Wrangler is only needed to deploy (`npm install` in this folder installs it, or just use
`npx wrangler`).

## Maintenance

- To allow another upstream site, add its host to `UPSTREAM_HOSTS` in `src/rules.js` after
  reading its terms of use and its `robots.txt`, give it a path rule in `FILE_PATHS` if its
  files are not plain `.mid` paths, and add a test for it.
- If a site changes its HTML, its search endpoint returns an empty list: update the reader in
  `src/search.js` and its fixture.
- `compatibility_date` in `wrangler.toml` pins the Workers runtime behavior; bump it
  deliberately.
