"""One catalog file per card of the song browser (contracts/catalog-files.md).

The song browser shows one memory card per source (Examples, MPB, Public domain, Open
collections). Each card loads one JSON file, `arranger/data/catalog/<source>.json`, only when the
visitor opens it, so the files are written to stay small and to diff well:

- an *envelope* says where the songs come from, under which license, whom to credit, what the
  file keeps (and what it does not), and which command wrote it;
- `entries` holds one song record per line, sorted by title without accents or letter case, then
  by id, so that a rerun on the same inputs writes the same bytes.

Each entry carries a *sprite seed*: the first 32 bits of SHA-256(`source:id`). The browser draws
the song's pixel-art sprite from it, so a song gets the same sprite on every visit and device.
"""

import hashlib
import json
import unicodedata
from collections.abc import Sequence
from pathlib import Path

ENVELOPE_FIELDS = ("source", "name", "home", "license", "credit", "note", "generated")


def sprite_seed(source: str, song_id: str) -> int:
    """Return the sprite seed of a song: the first 32 bits of SHA-256(`source:id`), big-endian.

    >>> sprite_seed("examples", "korobeiniki") == int(
    ...     hashlib.sha256(b"examples:korobeiniki").hexdigest()[:8], 16)
    True
    >>> sprite_seed("mpb", "aquarela") < 2**32
    True
    """
    digest = hashlib.sha256(f"{source}:{song_id}".encode()).digest()
    return int.from_bytes(digest[:4], "big")


def normalized_title(title: str) -> str:
    """Return the key that sorts titles as a reader expects: no accents, no letter case.

    >>> sorted(["Zebra", "abelha", "Ábaco"], key=normalized_title)
    ['Ábaco', 'abelha', 'Zebra']
    """
    decomposed = unicodedata.normalize("NFD", title)
    return "".join(char for char in decomposed if not unicodedata.combining(char)).casefold()


def catalog_text(envelope: dict, entries: Sequence[dict]) -> str:
    """Return the text of a catalog file: the envelope fields, then one entry per line.

    Entries are sorted by normalized title (`t`), then title, then id; their keys keep the order
    they were built in.

    >>> envelope = dict.fromkeys(ENVELOPE_FIELDS, "x") | {"source": "demo"}
    >>> entries = [{"id": "b", "t": "Zebra"}, {"id": "a", "t": "Ábaco"}]
    >>> print(catalog_text(envelope, entries), end="")
    {
      "source": "demo",
      "name": "x",
      "home": "x",
      "license": "x",
      "credit": "x",
      "note": "x",
      "generated": "x",
      "entries": [
        {"id":"a","t":"Ábaco"},
        {"id":"b","t":"Zebra"}
      ]
    }
    """
    missing = [field for field in ENVELOPE_FIELDS if field not in envelope]
    if missing:
        raise ValueError(f"the catalog envelope lacks {missing}")
    ordered = sorted(
        entries, key=lambda entry: (normalized_title(entry["t"]), entry["t"], entry["id"])
    )
    fields = [
        f"  {json.dumps(field)}: {json.dumps(envelope[field], ensure_ascii=False)}"
        for field in ENVELOPE_FIELDS
    ]
    lines = [
        "    " + json.dumps(entry, ensure_ascii=False, separators=(",", ":")) for entry in ordered
    ]
    body = ",\n".join(lines)
    entries_text = '  "entries": [\n' + body + "\n  ]" if lines else '  "entries": []'
    return "{\n" + ",\n".join([*fields, entries_text]) + "\n}\n"


def write_catalog_file(path: Path | str, envelope: dict, entries: Sequence[dict]) -> Path:
    """Write a catalog file (see `catalog_text`), creating its folder; return its path."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(catalog_text(envelope, entries), encoding="utf-8")
    return path
