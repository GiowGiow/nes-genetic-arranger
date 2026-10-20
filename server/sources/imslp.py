"""IMSLP (the Petrucci Music Library): scores of public-domain works, linked but not loaded.

IMSLP holds scanned scores (PDF), not MIDI or ABC, and the copyright status of each score
depends on the visitor's country. So the server only searches it and lists each work as a link
to its page; the visitor reads the page and its license there.

IMSLP runs MediaWiki, whose search API answers
`{"query": {"search": [{"ns": 0, "title": "Work (Composer, Name)", ...}]}}`. Namespace 0 holds
the work pages, and each title ends with the composer in parentheses.
"""

import json
import re
from urllib.parse import quote, urlencode

from server.fetcher import Fetcher
from server.sources import MAX_RESULTS_PER_SOURCE, SearchResult

SOURCE = "imslp"
SEARCH_URL = "https://imslp.org/api.php"
WIKI_URL = "https://imslp.org/wiki/"


def search_url(query: str) -> str:
    """The URL of IMSLP's search API for `query`, over work pages only."""
    parameters = [
        ("action", "query"),
        ("list", "search"),
        ("srsearch", query),
        ("srnamespace", "0"),
        ("srlimit", str(MAX_RESULTS_PER_SOURCE)),
        ("format", "json"),
    ]
    return f"{SEARCH_URL}?{urlencode(parameters)}"


def page_url(title: str) -> str:
    """The URL of a wiki page from its title (MediaWiki writes spaces as underscores).

    >>> page_url("Waltz in A minor (Example, Anna)")
    'https://imslp.org/wiki/Waltz_in_A_minor_(Example,_Anna)'
    """
    return WIKI_URL + quote(title.replace(" ", "_"), safe="(),._-'!:")


def parse_search(content: bytes) -> list[SearchResult]:
    """Turn IMSLP's search answer into link results.

    Raises:
        ValueError: the answer is not a search answer (for example an error object).
    """
    answer = json.loads(content)
    try:
        hits = answer["query"]["search"]
    except (KeyError, TypeError):
        raise ValueError("not an IMSLP search answer") from None
    if not isinstance(hits, list):
        raise ValueError("not an IMSLP search answer")
    results = []
    for hit in hits:
        title = str(hit.get("title", "")).strip()
        if not title:
            continue
        named = re.fullmatch(r"(.*\S)\s*\(([^()]*)\)", title)
        work, composer = (named[1], named[2]) if named else (title, "")
        page = page_url(title)
        results.append(
            SearchResult(
                source=SOURCE,
                id=title,
                title=work,
                composer=composer,
                license="varies",
                format="link",
                page=page,
                open=page,
            )
        )
    return results


def search(fetcher: Fetcher, query: str) -> list[SearchResult]:
    """Search IMSLP's work pages for `query` (one request)."""
    return parse_search(fetcher.get(search_url(query), {"json"}).content)
