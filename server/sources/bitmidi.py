"""BitMidi: a large public collection of MIDI files uploaded by its users, with a JSON API.

The search API (`https://bitmidi.com/api/midi/search?q=<query>&pageSize=30`) answers
`{"result": {"results": [...], "total": N, "pageTotal": M}}`, where each result has an `id`, a
`name`, a page `url` (`/<slug>`) and a `downloadUrl` (`/uploads/<id>.mid`). The files' licenses
are unknown, so the server loads them only when a visitor asks, keeps them no longer than its
temporary cache does, and the app marks them "unknown".
"""

import json
import re
from urllib.parse import urlencode

from server.fetcher import Fetcher
from server.sources import MAX_RESULTS_PER_SOURCE, SearchResult, file_route

SOURCE = "bitmidi"
SITE = "https://bitmidi.com"
SEARCH_URL = f"{SITE}/api/midi/search"
DOWNLOAD_PATH = re.compile(r"/uploads/([0-9]{1,12})\.mid")


def search_url(query: str) -> str:
    """The URL of BitMidi's search API for `query`, asking for one page of 30 results."""
    return f"{SEARCH_URL}?{urlencode({'q': query, 'pageSize': MAX_RESULTS_PER_SOURCE})}"


def file_url(file_id: str) -> str | None:
    """The download URL of a BitMidi file id (a number), or None for any other id.

    >>> file_url("101"), file_url("../101")
    ('https://bitmidi.com/uploads/101.mid', None)
    """
    if not re.fullmatch(r"[0-9]{1,12}", file_id):
        return None
    return f"{SITE}/uploads/{file_id}.mid"


def parse_search(content: bytes) -> list[SearchResult]:
    """Turn BitMidi's search answer into search results.

    Raises:
        ValueError: the answer is not a search answer (for example an error object).
    """
    answer = json.loads(content)
    try:
        hits = answer["result"]["results"]
    except (KeyError, TypeError):
        raise ValueError("not a BitMidi search answer") from None
    if not isinstance(hits, list):
        raise ValueError("not a BitMidi search answer")
    results = []
    for hit in hits:
        download = DOWNLOAD_PATH.fullmatch(str(hit.get("downloadUrl", "")))
        if download is None:
            continue
        file_id = download[1]
        name = str(hit.get("name", "")).strip()
        title = name[:-4] if name.lower().endswith(".mid") else name
        slug_url = hit.get("url")
        page = SITE + slug_url if isinstance(slug_url, str) and slug_url[:2] != "//" else SITE
        results.append(
            SearchResult(
                source=SOURCE,
                id=file_id,
                title=title or f"BitMidi file {file_id}",
                composer="",
                license="unknown",
                format="midi",
                page=page if page.startswith(SITE + "/") else SITE,
                open=file_route(SOURCE, file_id),
            )
        )
    return results


def search(fetcher: Fetcher, query: str) -> list[SearchResult]:
    """Search BitMidi for `query` (one request)."""
    return parse_search(fetcher.get(search_url(query), {"json"}).content)
