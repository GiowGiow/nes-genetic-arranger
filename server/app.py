"""The song server's HTTP routes (contracts/server-api.md), with CORS and per-visitor limits.

Routes (all GET):
- `/health`: `{"ok": true, "version": "<commit>"}` for probes and monitoring.
- `/songs/mpb/<id>.abc`: an MPB catalog song as an ABC lead sheet (see `sources.mpb`).
- `/search?q=<text>`: Mutopia, BitMidi and IMSLP searched at once, at most 30 results from each,
  with each site's status ("ok" or "error"), so one site being down hides only its own results.
- `/files/<source>/<id>`: a Mutopia or BitMidi file, MIDI or ABC, loaded on demand. Each source
  maps the id back to a URL on its own site (`file_url`), so this is not an open proxy.

A song on the takedown denylist (`server/denylist.json`) is neither listed nor served.

Every error is `{"error": "<plain sentence for the visitor>"}` with a fitting status, so the app
can show it as it is. Every answer says how long it may be cached: song files and lead sheets
are `private` (the visitor's browser may keep them, shared caches such as a CDN may not, so no
copy of a song outlives the server's own temporary cache), and errors are never cached.

Visitors:
- CORS lets only the project's GitHub Pages site, and localhost during development, read the
  answers; only GET is allowed and no credentials are accepted.
- Each visitor may make 60 requests a minute, 20 of them searches (`limits`); `/health` is
  exempt so that probes never fail on a busy day. Too many requests get 429 with `Retry-After`.
- Nothing about visitors is logged: uvicorn's access log is off, and the server's own log lines
  name only the upstream site and the kind of error.

Run it for development with `uv run --group server server/app.py` (http://127.0.0.1:8765); the
container runs `uvicorn server.app:app`.
"""

import json
import logging
import math
import os
import sys
import time
from collections.abc import Callable, Collection, Mapping
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import ModuleType
from urllib.parse import quote

if __package__ in (None, ""):
    # Run as a script: make the `server` package importable from the repository root.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from starlette.applications import Starlette
from starlette.datastructures import Headers
from starlette.exceptions import HTTPException
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse, Response
from starlette.routing import Route
from starlette.types import ASGIApp, Receive, Scope, Send

from server.fetcher import Fetcher, FetchError, TooLarge, WrongContent
from server.limits import RateLimiter, client_key
from server.sources import MAX_RESULTS_PER_SOURCE, SearchResult, bitmidi, imslp, mpb, mutopia

REPOSITORY = Path(__file__).resolve().parents[1]
CATALOG_DIR = REPOSITORY / "arranger" / "data" / "catalog"
DENYLIST_PATH = Path(__file__).with_name("denylist.json")

PAGES_ORIGIN = "https://giowgiow.github.io"
LOCAL_ORIGINS = r"http://(localhost|127\.0\.0\.1)(:\d{1,5})?"
UVICORN_OPTIONS = {"host": "127.0.0.1", "port": 8765, "access_log": False}

NO_STORE = "no-store"
PRIVATE_CACHE = "private, max-age=3600"
SEARCH_CACHE = "private, max-age=300"

SEARCH_SOURCES = (mutopia, bitmidi, imslp)
FILE_SOURCES = {"mutopia": mutopia, "bitmidi": bitmidi}
QUERY_LENGTH = (2, 100)
FILE_TYPES = {"midi": "audio/midi", "abc": "text/plain; charset=utf-8"}

logger = logging.getLogger("nes_arranger.server")


def error_response(status: int, message: str, headers: Mapping[str, str] | None = None) -> Response:
    """The JSON error every route sends: `{"error": message}`, never cached."""
    return JSONResponse(
        {"error": message},
        status_code=status,
        headers={"Cache-Control": NO_STORE, **(headers or {})},
    )


def load_denylist(path: Path) -> dict[str, frozenset[str]]:
    """Read the takedown denylist: song ids per source (the "comment" field is skipped)."""
    listed = json.loads(path.read_text(encoding="utf-8"))
    return {source: frozenset(ids) for source, ids in listed.items() if isinstance(ids, list)}


def header_safe(url: str) -> str:
    """A URL fit for an HTTP header (non-ASCII characters percent-encoded).

    >>> header_safe("https://www.beakauffmann.com/mpb_a/açaí.html")
    'https://www.beakauffmann.com/mpb_a/a%C3%A7a%C3%AD.html'
    """
    return quote(url, safe=":/?#[]@!$&'()*+,;=%~")


class RateLimitMiddleware:
    """Refuse a visitor's request with 429 when their token bucket is empty (see `limits`)."""

    def __init__(self, app: ASGIApp, limiter: RateLimiter) -> None:
        self.app = app
        self.limiter = limiter

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] == "/health":
            await self.app(scope, receive, send)
            return
        peer = scope.get("client")
        visitor = client_key(Headers(scope=scope).get("x-forwarded-for"), peer[0] if peer else None)
        wait = self.limiter.check(visitor, search=scope["path"] == "/search")
        if wait > 0:
            response = error_response(
                429,
                "Too many requests from your address. Please wait a moment and try again.",
                {"Retry-After": str(math.ceil(wait))},
            )
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)


def create_app(
    catalog_dir: Path = CATALOG_DIR,
    fetcher: Fetcher | None = None,
    denylist: Mapping[str, Collection[str]] | None = None,
    version: str | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> Starlette:
    """Build the song server.

    Args:
        catalog_dir: folder with the committed catalogs (`mpb.json`); a missing file means an
            empty catalog.
        fetcher: the way out to the internet; tests pass one on a fake internet.
        denylist: song ids per source that the server refuses (takedowns); by default
            `server/denylist.json`.
        version: the deployed commit for `/health`; by default `$APP_COMMIT`, else "dev".
        clock: monotonic clock for the rate limits.
    """
    fetcher = fetcher if fetcher is not None else Fetcher()
    listed = load_denylist(DENYLIST_PATH) if denylist is None else denylist
    denied = {source: frozenset(ids) for source, ids in listed.items()}
    mpb_catalog = mpb.load_catalog(Path(catalog_dir) / "mpb.json")
    version = version or os.environ.get("APP_COMMIT") or "dev"

    def health(request: Request) -> Response:
        return JSONResponse({"ok": True, "version": version}, headers={"Cache-Control": NO_STORE})

    def mpb_song(request: Request) -> Response:
        song_id = request.path_params["song_id"]
        entry = mpb_catalog.get(song_id)
        if entry is None or song_id in denied.get("mpb", ()):
            return error_response(404, "This song is not in the MPB catalog.")
        if "route" not in entry or "error" in entry:
            reason = entry.get("error", "no lead sheet could be made")
            return error_response(422, f"This song cannot be arranged ({reason}).")
        try:
            abc = mpb.lead_sheet_abc(fetcher, entry)
        except mpb.SongChanged:
            return error_response(
                409,
                "This song's MIDI file has changed at its source since the catalog was made, "
                "so the server will not reduce it.",
            )
        except (mpb.CannotReduce, TooLarge):
            return error_response(422, "This song's MIDI file cannot be reduced to a lead sheet.")
        except FetchError as error:
            logger.warning("MPB file not loaded: %s (%s)", type(error).__name__, error)
            return error_response(
                502, "The catalog site did not send this song's MIDI file. Try again later."
            )
        return PlainTextResponse(
            abc,
            headers={
                "X-Source-Page": header_safe(entry.get("u", "")),
                "Cache-Control": PRIVATE_CACHE,
            },
        )

    def search_source(source: ModuleType, query: str) -> tuple[list[SearchResult], str]:
        try:
            found = source.search(fetcher, query)
        except Exception as error:
            # A site that is down, slow or changed its pages must not break the whole search.
            logger.warning("search on %s failed: %s", source.SOURCE, type(error).__name__)
            return [], "error"
        allowed = [hit for hit in found if hit.id not in denied.get(source.SOURCE, ())]
        return allowed[:MAX_RESULTS_PER_SOURCE], "ok"

    def search(request: Request) -> Response:
        query = request.query_params.get("q", "").strip()
        shortest, longest = QUERY_LENGTH
        if len(query) < shortest:
            return error_response(400, f"Type at least {shortest} characters to search.")
        if len(query) > longest:
            return error_response(400, f"Type at most {longest} characters to search.")
        with ThreadPoolExecutor(max_workers=len(SEARCH_SOURCES)) as pool:
            answers = list(pool.map(lambda source: search_source(source, query), SEARCH_SOURCES))
        results = [hit.to_json() for hits, _ in answers for hit in hits]
        statuses = {
            source.SOURCE: status
            for source, (_, status) in zip(SEARCH_SOURCES, answers, strict=True)
        }
        return JSONResponse(
            {"results": results, "sources": statuses}, headers={"Cache-Control": SEARCH_CACHE}
        )

    def files(request: Request) -> Response:
        source_name, file_id = request.path_params["source"], request.path_params["file_id"]
        source = FILE_SOURCES.get(source_name)
        url = source.file_url(file_id) if source else None
        if url is None or file_id in denied.get(source_name, ()):
            return error_response(404, "The server does not load this file.")
        try:
            fetched = fetcher.get(url, FILE_TYPES)
        except TooLarge:
            return error_response(413, "This file is larger than the 2 MB the server accepts.")
        except WrongContent:
            return error_response(415, "This file is neither a MIDI file nor an ABC tune.")
        except FetchError as error:
            logger.warning("file from %s not loaded: %s", source_name, type(error).__name__)
            return error_response(502, "The site did not send this file. Try again later.")
        return Response(
            fetched.content,
            media_type=FILE_TYPES[fetched.kind],
            headers={"Cache-Control": PRIVATE_CACHE},
        )

    async def http_error(request: Request, exc: HTTPException) -> Response:
        messages = {
            404: "There is nothing at this address.",
            405: "This server answers GET requests only.",
        }
        message = messages.get(exc.status_code, "The server did not understand this request.")
        return error_response(exc.status_code, message, exc.headers)

    async def server_error(request: Request, exc: Exception) -> Response:
        logger.error("unexpected %s", type(exc).__name__)
        return error_response(500, "The song server hit an unexpected error.")

    return Starlette(
        routes=[
            Route("/health", health, methods=["GET"]),
            Route("/songs/mpb/{song_id}.abc", mpb_song, methods=["GET"]),
            Route("/search", search, methods=["GET"]),
            Route("/files/{source}/{file_id:path}", files, methods=["GET"]),
        ],
        middleware=[
            Middleware(
                CORSMiddleware,
                allow_origins=[PAGES_ORIGIN],
                allow_origin_regex=LOCAL_ORIGINS,
                allow_methods=["GET"],
                allow_credentials=False,
                expose_headers=["X-Source-Page", "Retry-After"],
                max_age=600,
            ),
            Middleware(RateLimitMiddleware, limiter=RateLimiter(clock=clock)),
        ],
        exception_handlers={HTTPException: http_error, Exception: server_error},
    )


def main() -> None:
    """Serve the app on http://127.0.0.1:8765 for development, without an access log."""
    import uvicorn

    uvicorn.run(app, **UVICORN_OPTIONS)


app = create_app()

if __name__ == "__main__":
    main()
