"""MPB catalog songs, loaded on demand and reduced to ABC lead sheets with the recorded facts.

The MPB catalog (Beatriz Kauffmann's Web Site) holds about 3,760 fan-made MIDI files of
Brazilian songs, marked "All Rights Reserved". The repository may not hold their notes, so the
committed catalog (`arranger/data/catalog/mpb.json`) keeps only metadata and *analysis facts*:
the file's URL and SHA-256, the melody track, the bar range and the sections that the command
line measured (data model, "Analysis facts").

When a visitor opens such a song, the server:

1. downloads the MIDI file from the site (through the fetcher, so with every safety rule);
2. checks its SHA-256 against the catalog: a file that changed since the analysis would not match
   the recorded melody track and bars, so it is refused rather than reduced wrongly;
3. reduces it with the command line's own reader (`leadsheet.midi_reader`) and the recorded
   options, and writes the lead sheet as ABC (`leadsheet.abc_writer`), so the result equals the
   command line's reduction by construction;
4. returns the ABC text. The MIDI bytes stay only in the fetcher's temporary memory cache, and
   the temporary file the reader needs is deleted at once.
"""

import hashlib
import json
import tempfile
from dataclasses import replace
from pathlib import Path

from leadsheet.abc_writer import lead_sheet_to_abc
from leadsheet.midi_reader import read_lead_sheet_midi
from server.fetcher import Fetcher

PHRASE_LENGTH = 4  # research R13: one "A" section, phrases of 4 bars
LICENSE_NAMES = {"all-rights-reserved": "All Rights Reserved"}


class SongChanged(Exception):
    """The source file's SHA-256 differs from the one recorded in the catalog."""


class CannotReduce(Exception):
    """The reader could not reduce the file to a lead sheet with the recorded options."""


def load_catalog(path: Path) -> dict[str, dict]:
    """Return the catalog's entries by id; a missing file gives an empty catalog."""
    if not path.exists():
        return {}
    envelope = json.loads(path.read_text(encoding="utf-8"))
    return {entry["id"]: entry for entry in envelope.get("entries", [])}


def provenance(entry: dict) -> list[str]:
    """The `%` comment lines that credit the song and say how the lead sheet was made."""
    facts = entry["facts"]
    bars = facts.get("bars")
    excerpt = f"bars {bars[0]}-{bars[1]} (0-based, end excluded)" if bars else "all bars"
    sections = ", ".join(f"{label} at bar {bar}" for bar, label in facts.get("sections") or [])
    license_name = LICENSE_NAMES.get(entry.get("license", ""), entry.get("license", "unknown"))
    return [
        f"{entry['t']}, composers: {entry.get('c') or 'unknown'}; "
        f"performed by {entry.get('p') or 'unknown'}.",
        f"Source: {entry.get('u', '')} (file {facts['midi']}, sha256 {facts['sha256']}), "
        f"{license_name}. Loaded on demand from the source; the song server keeps no copy.",
        "This lead sheet is the project's reduction of a fan-made MIDI file: the melody of one "
        "track, the chords detected in the other tracks and the part labels. It is not the "
        "original recording or arrangement.",
        f"Reduced by the nes-genetic-arranger song server: melody track "
        f"{facts['melody_track']}, {excerpt}, sections {sections or 'A at bar 0'}, beat grid "
        "auto.",
    ]


def reduce_to_abc(entry: dict, midi_bytes: bytes) -> str:
    """Reduce a catalog song's MIDI bytes to an ABC lead sheet with the entry's facts.

    Raises:
        SongChanged: the bytes' SHA-256 is not the one in the catalog.
        CannotReduce: the reader or the ABC writer refused the song.
    """
    facts = entry["facts"]
    if hashlib.sha256(midi_bytes).hexdigest() != facts["sha256"]:
        raise SongChanged(entry["id"])
    bars = facts.get("bars")
    sections = [(int(bar), str(label)) for bar, label in facts.get("sections") or [(0, "A")]]
    with tempfile.TemporaryDirectory(prefix="nes-arranger-") as folder:
        path = Path(folder) / "song.mid"
        path.write_bytes(midi_bytes)
        try:
            lead_sheet = read_lead_sheet_midi(
                path,
                facts["melody_track"],
                phrase_length=PHRASE_LENGTH,
                bars=tuple(bars) if bars else None,
                sections=sections,
                grid="auto",
            )
            titled = replace(lead_sheet, title=entry["t"])
            return lead_sheet_to_abc(titled, PHRASE_LENGTH, provenance(entry))
        except Exception as error:
            # Bytes from another site go through a third-party MIDI parser, which can fail in
            # many ways; each one means the same to the visitor: this song cannot be read.
            raise CannotReduce(type(error).__name__) from None


def lead_sheet_abc(fetcher: Fetcher, entry: dict) -> str:
    """Download a catalog song's MIDI file and return its ABC lead sheet."""
    fetched = fetcher.get(entry["facts"]["midi"], {"midi"})
    return reduce_to_abc(entry, fetched.content)
