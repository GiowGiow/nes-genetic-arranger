"""One module per music site the server reads, and the search result they all return.

- `mpb`: the MPB catalog (Beatriz Kauffmann's Web Site). Songs are listed in the committed
  catalog with their analysis facts; the server loads the MIDI file on demand and reduces it to an
  ABC lead sheet.
- `mutopia`, `bitmidi`, `imslp`: external sites the visitor can search. Mutopia and BitMidi files
  are loaded on demand; IMSLP results only link to the work's page.

Each search module offers `search_url(query)`, a pure `parse_search(content)` tested on small
synthetic fixtures shaped like the site's answer, and `search(fetcher, query)`. The modules that
serve files also offer `file_url(file_id)`, which maps a result's id back to a URL on the site and
refuses anything else, so `/files` cannot be used to fetch arbitrary URLs.
"""

from dataclasses import asdict, dataclass
from urllib.parse import quote

MAX_RESULTS_PER_SOURCE = 30


@dataclass(frozen=True)
class SearchResult:
    """One search hit, normalized across sites (data model, "Search result").

    `format` is "midi" or "abc" when the server can load the file, and "link" when the visitor
    can only open the page. `open` is what the app opens: a server path (`/files/<source>/<id>`,
    relative to the server's base URL) or, for a link, the page itself.
    """

    source: str
    id: str
    title: str
    composer: str
    license: str
    format: str
    page: str
    open: str

    def to_json(self) -> dict[str, str]:
        """The result as the JSON object the app reads."""
        return asdict(self)


def file_route(source: str, file_id: str) -> str:
    """The server path that loads a result's file.

    >>> file_route("mutopia", "BachJS/BWV999/prelude/prelude.mid")
    '/files/mutopia/BachJS/BWV999/prelude/prelude.mid'
    """
    return f"/files/{source}/{quote(file_id, safe='/')}"
