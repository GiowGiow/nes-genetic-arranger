"""The Mutopia Project: free sheet music typeset with LilyPond, each piece with a MIDI file.

Mutopia's pieces are in the public domain or under Creative Commons licenses, and each one has a
MIDI file in the site's FTP area (`https://www.mutopiaproject.org/ftp/...`). The site has no JSON
API; its search page (`cgibin/make-table.cgi?searchingfor=<query>`) lists up to 10 pieces, each in
its own small table:

    row 1: title | "by <composer> (<years>)" | opus | lyricist
    row 2: instruments | date | style | arranger
    row 3: source | license link | "More Information" link (piece-info.cgi?id=N) | date added
    row 4: download links: .ly, .mid, preview image, FTP area

This module reads those tables with the standard library's HTML parser. A piece whose MIDI comes
only zipped (a multi-movement work) is listed as a link to its page.
"""

import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from urllib.parse import urlencode, urljoin

from server.fetcher import Fetcher
from server.sources import SearchResult, file_route

SOURCE = "mutopia"
SEARCH_URL = "https://www.mutopiaproject.org/cgibin/make-table.cgi"
FTP_URL = "https://www.mutopiaproject.org/ftp/"
FILE_ID = re.compile(r"[A-Za-z0-9_.+-]+(/[A-Za-z0-9_.+-]+)*\.mid")


@dataclass
class Cell:
    """One table cell: its text and the links in it."""

    text: str = ""
    links: list[str] = field(default_factory=list)


class ResultTables(HTMLParser):
    """Collect each `result-table` of the page as a list of rows of cells."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[list[list[Cell]]] = []
        self._inside = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "table" and "result-table" in (attributes.get("class") or "").split():
            self.tables.append([])
            self._inside = True
        elif not self._inside:
            return
        elif tag == "tr":
            self.tables[-1].append([])
        elif tag == "td" and self.tables[-1]:
            self.tables[-1][-1].append(Cell())
        elif tag == "a" and attributes.get("href") and self._cell() is not None:
            self._cell().links.append(attributes["href"])

    def handle_endtag(self, tag: str) -> None:
        if tag == "table":
            self._inside = False

    def handle_data(self, data: str) -> None:
        cell = self._cell() if self._inside else None
        if cell is not None:
            cell.text += data

    def _cell(self) -> Cell | None:
        rows = self.tables[-1] if self.tables else []
        return rows[-1][-1] if rows and rows[-1] else None


def search_url(query: str) -> str:
    """The URL of Mutopia's search listing for `query`."""
    return f"{SEARCH_URL}?{urlencode({'searchingfor': query})}"


def license_tag(name: str) -> str:
    """Shorten a Mutopia license name to the tag the app shows.

    >>> license_tag("Public Domain"), license_tag("Creative Commons Attribution-ShareAlike 3.0")
    ('public-domain', 'CC-BY-SA-3.0')
    """
    if name.lower() == "public domain":
        return "public-domain"
    match = re.fullmatch(r"Creative Commons Attribution(-ShareAlike)? ([\d.]+)", name)
    if match:
        return f"CC-BY{'-SA' if match[1] else ''}-{match[2]}"
    return name


def file_url(file_id: str) -> str | None:
    """The URL of a MIDI file in Mutopia's FTP area, or None for any other id.

    >>> file_url("BachJS/BWV999/prelude/prelude.mid")
    'https://www.mutopiaproject.org/ftp/BachJS/BWV999/prelude/prelude.mid'
    >>> file_url("../prelude.mid") is None
    True
    """
    if not FILE_ID.fullmatch(file_id) or ".." in file_id.split("/"):
        return None
    return FTP_URL + file_id


def parse_search(content: bytes) -> list[SearchResult]:
    """Turn Mutopia's search listing into search results, in the listing's order."""
    parser = ResultTables()
    parser.feed(content.decode("utf-8", errors="replace"))
    results = []
    for rows in parser.tables:
        if len(rows) < 3 or len(rows[0]) < 2 or len(rows[2]) < 3:
            continue
        links = [link for row in rows for cell in row for link in cell.links]
        info = next((link for link in links if "piece-info.cgi" in link), None)
        page = urljoin(SEARCH_URL, info) if info else "https://www.mutopiaproject.org/"
        midi_ids = [
            link.removeprefix(FTP_URL)
            for link in links
            if link.startswith(FTP_URL) and file_url(link.removeprefix(FTP_URL))
        ]
        if midi_ids:
            file_id, kind, opened = midi_ids[0], "midi", file_route(SOURCE, midi_ids[0])
        else:
            number = re.search(r"id=(\d+)", info or "")
            file_id, kind, opened = f"piece-{number[1] if number else len(results)}", "link", page
        results.append(
            SearchResult(
                source=SOURCE,
                id=file_id,
                title=rows[0][0].text.strip(),
                composer=rows[0][1].text.strip().removeprefix("by ").strip(),
                license=license_tag(rows[2][1].text.strip()),
                format=kind,
                page=page,
                open=opened,
            )
        )
    return results


def search(fetcher: Fetcher, query: str) -> list[SearchResult]:
    """Search Mutopia for `query` (one request: the first page of the listing)."""
    return parse_search(fetcher.get(search_url(query), {"html"}).content)
