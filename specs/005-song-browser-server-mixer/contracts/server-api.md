# Contract: song server HTTP API

Base URL: `https://nes-arranger-bh.giow.dev` (production), `http://localhost:8765` (development).
All routes are GET, return CORS headers for the allowed origins, and send `Cache-Control`.

| Route | 200 response | Errors |
|---|---|---|
| `/health` | `{"ok": true, "version": "<commit>"}` | — |
| `/songs/mpb/<id>.abc` | `text/plain` ABC lead sheet reduced with the entry's facts; header `X-Source-Page` | 404 unknown id or denylisted; 409 source SHA-256 changed; 422 cannot be reduced; 502 source unreachable |
| `/search?q=<text>` | `{"results": [SearchResult], "sources": {"mutopia": "ok" \| "error", …}}`, at most 30 per source | 400 query shorter than 2 characters |
| `/files/<source>/<id>` | the file bytes (`audio/midi` or `text/plain`) | 404 unknown or denylisted; 413 over 2 MB; 415 not MIDI/ABC; 502 source unreachable |

Every error body is `{"error": "<plain sentence for the visitor>"}`. Rate-limited requests get 429
with `Retry-After`. No route accepts uploads, cookies or credentials.
