"""Lead sheets the repository may redistribute: public-domain MPB songs and open collections.

The song browser's "Public domain" and "Open collections" cards open lead sheets committed in
`data/catalog/abc/`, with no song server involved. Each collection keeps its license next to its
files, and every file starts with `%` lines that say where it comes from (constitution,
"Third-party material"; contracts/catalog-files.md):

- **Public-domain MPB**: songs of the MPB catalog whose every author died in 1955 or earlier
  (`catalog.authors`), reduced from the local study copy with the catalog's own facts, so the
  file equals what the song server would serve.
- **Nottingham** (GPL-3.0): about a thousand British and American folk tunes in ABC, as cleaned
  by Jukedeck.
- **PDMX** (CC BY 4.0): MuseScore scores marked public domain or CC0 whose composer died in 1955
  or earlier, ranked by views, the most viewed first (research R12).

Folk ABC writes repeat signs, pickups and chord symbols, which the lead-sheet ABC reader refuses
by design. Such a tune goes through the MIDI reduction instead (research R10):

1. music21 parses the tune and writes its repeats out (`expandRepeats`).
2. A pickup (an incomplete first bar) gets a leading rest, so bar lines fall where the meter
   puts them.
3. The chord symbols are played by an accompaniment track (the chord's notes) and a bass track
   (its root), so the chord detection of `leadsheet.midi_reader` finds them again.
4. The MIDI song is reduced with track 0 as the melody, like any MIDI song.

Two details of the folk files need care first. A repeat sign `:|` with no `|:` before it makes
music21 go back to the start of the tune, where ABC means the start of the part (after `||` or a
`P:` line), so the missing `|:` is written in. And the cleaned Nottingham files spell some chords
their own way ("Gd" diminished, "D/f+" for D over F sharp), which are respelled for music21.
The part order of a `Y:` line is not followed: each part plays once, as written, with its repeats.
"""

import argparse
import csv
import re
import shutil
import tarfile
import tempfile
import textwrap
from collections.abc import Callable, Collection, Iterable, Mapping, Sequence
from dataclasses import replace
from pathlib import Path

import pretty_midi
from music21 import abcFormat, converter, harmony, key, meter, stream, tempo

from catalog.analysis import (
    MIDI_SONG_OVERRIDES,
    MPB_HOME,
    PHRASE_LENGTH,
    DatasetRow,
    analyze_and_reduce,
    check_bar_lines,
    checked_abc,
    estimate_key,
    guarded,
    mpb_entry,
    parallel_map,
    pitch_class_weights,
    read_dataset,
    short_reason,
)
from catalog.authors import (
    AuthorRecord,
    read_authors,
    song_is_public_domain,
    split_composers,
)
from catalog.cards import sprite_seed, write_catalog_file
from leadsheet.abc_reader import DEFAULT_TEMPO_BPM, read_lead_sheet_text
from leadsheet.midi_reader import bar_map, read_lead_sheet_midi
from leadsheet.model import LeadSheet
from leadsheet.sources import file_sha256, load_sources

MAX_BARS = 256  # the longest lead sheet the arranger takes
COMMENT_WIDTH = 96
TICKS_PER_BEAT = 480
ABC_ROOT = Path("data/catalog/abc")
CATALOG_ROOT = Path("arranger/data/catalog")
DEFAULT_AUTHORS = Path("data/catalog/authors.json")

NOTTINGHAM_HOME = "https://github.com/jukedeck/nottingham-dataset"
PDMX_RECORD = "https://zenodo.org/records/15571083"
PDMX_DOI = "10.5281/zenodo.15571083"
PDMX_LICENSES = {"publicdomain": "PDM", "cc-zero": "CC0"}
PDMX_BARS = (8, 256)
# How many PDMX scores to keep: the most viewed ones, which are the ones people know.
PDMX_LIMIT = 300
# The PDMX.csv columns the filter and the writer read (the file has more).
PDMX_COLUMNS = (
    "path",
    "mid",
    "is_original",
    "n_ratings",
    "rating",
    "n_views",
    "n_favorites",
    "license",
    "license_url",
    "song_name",
    "title",
    "composer_name",
    "artist_name",
    "song_length.bars",
    "is_best_unique_arrangement",
    "subset:no_license_conflict",
)

# The hand-written lead sheets of the two traditional tunes (arranger/src/ui/examples.js).
TRADITIONAL_EXAMPLES = (
    ("korobeiniki", "Korobeiniki (Tetris theme)", "Traditional (Russia)"),
    ("ievan_polkka", "Ievan Polkka", "Traditional (Finland)"),
)

# A bar-line token of an ABC body line, after quoted strings and inline fields, which hold none.
BAR_TOKEN = re.compile(
    r'%.*|"[^"]*"|\[[A-Za-z]:[^\]]*\]|:\|\|:|:\|:|:\|\||:\|\]?|::|\|:|\|\||\|\]|\[\||\|'
)
ENDING_AHEAD = re.compile(r"\s*(\[?[12]|\[\d)")
# Repeat ends, with the text that starts a repeat right after each one: ":|" + "|:" reads as
# ":||:", ":||" + ":" too, and "|]" needs a space. "::" and its spellings also start a repeat.
REPEAT_ENDS = {":|": "|:", ":||": ":", ":|]": " |:", "::": "", ":||:": "", ":|:": ""}
END_AND_START = ("::", ":||:", ":|:")
FIELD_LINE = re.compile(r"^[A-Za-z+]:")


# --- ABC tunes through the MIDI reduction (research R10) ---


def split_tunes(text: str) -> list[tuple[int, str]]:
    """Split a collection file into its tunes: (X: number, tune text), in file order.

    >>> [(n, t.splitlines()[1]) for n, t in split_tunes("X: 1\\nT:A\\nK:C\\nC|\\n\\nX:2\\nT:B\\n")]
    [(1, 'T:A'), (2, 'T:B')]
    """
    tunes, current = [], None
    for line in text.splitlines():
        if line.startswith("X:"):
            if current:
                tunes.append(current)
            current = [line]
        elif current is not None:
            current.append(line)
    if current:
        tunes.append(current)
    return [(int(lines[0][2:].strip()), "\n".join(lines).strip() + "\n") for lines in tunes]


def normalize_chord_symbol(symbol: str) -> str:
    """Respell a folk chord symbol for music21: "Gd" diminished, "Ca" augmented, "D/f+" over F#.

    >>> [normalize_chord_symbol(symbol) for symbol in ("D7/f+", "Bbd", "(A7)")]
    ['D7/F#', 'Bbdim', 'A7']
    """
    symbol = symbol.strip().removeprefix("(").removesuffix(")")
    chord, _, bass = symbol.partition("/")
    found = re.match(r"^([A-G][#b]?)(.*)$", chord)
    if found is None:
        return symbol
    root, quality = found.groups()
    if quality.startswith("d") and not quality.startswith("dim"):
        quality = "dim" + quality[1:]
    elif quality.startswith("a") and not quality.startswith("aug"):
        quality = "aug" + quality[1:]
    if bass:
        bass_note = re.match(r"^([a-gA-G])([#b+-]?)$", bass)
        if bass_note is None:
            return root + quality
        letter, sign = bass_note.groups()
        bass = letter.upper() + {"+": "#", "#": "#", "-": "b", "b": "b"}.get(sign, "")
        return f"{root}{quality}/{bass}"
    return root + quality


def mark_repeat_starts(body: Sequence[str]) -> list[str]:
    """Write in the `|:` that ABC implies where a repeat goes back to a part or a double bar.

    ABC repeats `:|` back to the last `|:`, or, without one, to the start of the section: the
    tune start, a `P:` line, a double bar `||`, or the end of the previous repeat. music21 always
    goes back to the tune start, so a `|:` is inserted at the section start when it is missing.

    >>> mark_repeat_starts(["CDEF|GABc:||defg|abcd:|"])
    ['CDEF|GABc:||:defg|abcd:|']
    >>> mark_repeat_starts(["P:B", "defg|abcd:|"])
    ['P:B', '|:defg|abcd:|']
    """
    lines = list(body)
    inserts: list[tuple[int, int, str]] = []
    start: tuple[int, int, str] | None = None  # where a "|:" would go; None = tune start
    is_open, pending_part = False, False
    for row, line in enumerate(lines):
        if FIELD_LINE.match(line):
            if line.startswith("P:"):
                pending_part, is_open = True, False
            continue
        if pending_part and line.strip():
            pending_part = False
            indent = len(line) - len(line.lstrip())
            start = (row, indent, "|:")
        for token in BAR_TOKEN.finditer(line):
            text = token.group()
            if text.startswith(("%", '"', "[")) and text not in ("[|",):
                if text.startswith("%"):
                    break
                continue
            if text in REPEAT_ENDS:
                if not is_open and start is not None:
                    inserts.append(start)
                is_open = text in END_AND_START
                if is_open or ENDING_AHEAD.match(line, token.end()):
                    start = None  # an open repeat, or endings follow: no section starts here
                else:
                    start = (row, token.end(), REPEAT_ENDS[text])
            elif text == "|:":
                is_open = True
            elif text in ("||", "|]", "[|") and not is_open:
                # A double bar inside an open repeat does not end it: ":|" still goes to "|:".
                start = (row, token.end(), " |:")
    for row, column, text in sorted(set(inserts), reverse=True):
        lines[row] = lines[row][:column] + text + lines[row][column:]
    return lines


def respell_line(line: str) -> str:
    """Respell one body line for music21: chord symbols, and ":|:" as the equivalent "::".

    music21 reads ":|:" as a repeat end only, so the repeat that starts there would be lost.

    >>> respell_line('"Gd"G2:|:"D/f+"A2|')
    '"Gdim"G2::"D/F#"A2|'
    """
    if FIELD_LINE.match(line):
        return line
    pieces = re.split(r'("[^"]*")', line)
    for index, piece in enumerate(pieces):
        if piece.startswith('"') and piece.endswith('"') and len(piece) > 1:
            if piece[1:2] not in ("^", "_", "<", ">", "@"):
                pieces[index] = f'"{normalize_chord_symbol(piece[1:-1])}"'
        elif "%" in piece:  # a comment runs to the end of the line
            comment = piece.index("%")
            pieces[index] = piece[:comment].replace(":|:", "::") + piece[comment:]
            break
        else:
            pieces[index] = piece.replace(":|:", "::")
    return "".join(pieces)


def prepare_tune(abc_text: str) -> str:
    """Respell the body for music21 and write in implied repeat starts (module docstring)."""
    lines = abc_text.splitlines()
    head = next((n + 1 for n, line in enumerate(lines) if line.startswith("K:")), 0)
    body = [respell_line(line) for line in lines[head:]]
    return "\n".join(lines[:head] + mark_repeat_starts(body)) + "\n"


def abc_tune_to_midi(abc_text: str) -> pretty_midi.PrettyMIDI:
    """Turn one ABC tune into a MIDI song: melody, chord accompaniment and bass (research R10).

    Track 0 ("melody") holds the tune with its repeats written out, after a leading rest that
    fills a pickup to a full bar. Track 1 ("chords") plays each chord symbol's notes until the
    next symbol, and track 2 ("bass") its root two octaves below middle C.

    Raises:
        ValueError: when music21 cannot read the tune or it has no notes.
    """
    try:
        score = converter.parse(prepare_tune(abc_text), format="abc")
        if isinstance(score, stream.Opus):
            score = score.scores[0]
        part = score.expandRepeats().parts[0].stripTies()
    except Exception as error:  # music21 raises many kinds on malformed ABC
        raise ValueError(f"music21 cannot read the tune ({type(error).__name__})") from error
    measures = part.getElementsByClass(stream.Measure)
    padding = float(measures[0].paddingLeft) if measures else 0.0
    flat = part.flatten()
    marks = flat.getElementsByClass(tempo.MetronomeMark)
    bpm = float(marks[0].getQuarterBPM()) if marks else DEFAULT_TEMPO_BPM
    seconds = 60.0 / bpm

    def time(offset: float) -> float:
        return (float(offset) + padding) * seconds

    midi = pretty_midi.PrettyMIDI(resolution=TICKS_PER_BEAT, initial_tempo=bpm)
    current = None
    for signature in flat.getElementsByClass(meter.TimeSignature):
        # Written-out repeats restate the meter where they start, which may be mid-bar after a
        # pickup; only a real change of meter goes into the file's time-signature map.
        if signature.ratioString == current:
            continue
        current = signature.ratioString
        at = 0.0 if signature.offset == 0 else time(signature.offset)
        midi.time_signature_changes.append(
            pretty_midi.TimeSignature(signature.numerator, signature.denominator, at)
        )
    melody = pretty_midi.Instrument(program=73, name="melody")
    for element in flat.notes:
        if isinstance(element, harmony.ChordSymbol) or element.quarterLength <= 0:
            continue
        start, end = time(element.offset), time(element.offset + element.quarterLength)
        for pitch in element.pitches:
            melody.notes.append(pretty_midi.Note(90, pitch.midi, start, end))
    if not melody.notes:
        raise ValueError("the tune has no notes")
    chords = pretty_midi.Instrument(program=0, name="chords")
    bass = pretty_midi.Instrument(program=32, name="bass")
    symbols = [
        symbol
        for symbol in flat.getElementsByClass(harmony.ChordSymbol)
        if not isinstance(symbol, harmony.NoChord) and symbol.pitches
    ]
    if not symbols:
        # Without chord symbols, the chords are detected from the melody itself.
        chords.notes = [
            pretty_midi.Note(70, note.pitch, note.start, note.end) for note in melody.notes
        ]
    ends = [symbol.offset for symbol in symbols[1:]] + [flat.highestTime]
    for symbol, end_offset in zip(symbols, ends[: len(symbols)], strict=True):
        if end_offset <= symbol.offset:
            continue
        start, end = time(symbol.offset), time(end_offset)
        for pitch in symbol.pitches:
            chords.notes.append(pretty_midi.Note(70, pitch.midi, start, end))
        bass.notes.append(pretty_midi.Note(80, 36 + symbol.root().pitchClass, start, end))
    midi.instruments += [melody, chords, bass]
    return midi


def reduce_tune(abc_text: str, phrase_length: int = PHRASE_LENGTH) -> LeadSheet:
    """Reduce one ABC tune to a lead sheet through `abc_tune_to_midi` (research R10).

    The lead sheet keeps the tune's title (`T:`) and key (`K:`), one section "A".

    Raises:
        ValueError: when the tune cannot be read, has a meter the arranger does not support, or
            is longer than 256 bars.
    """
    midi = abc_tune_to_midi(abc_text)
    check_bar_lines(bar_map(midi))
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "tune.mid"
        midi.write(str(path))
        lead_sheet = read_lead_sheet_midi(path, 0, phrase_length=phrase_length, grid="file")
    if len(lead_sheet.bars) > MAX_BARS:
        raise ValueError(f"the tune is {len(lead_sheet.bars)} bars long, over {MAX_BARS}")
    title = next((line[2:].strip() for line in abc_text.splitlines() if line.startswith("T:")), "")
    # A MIDI file stores the tempo in whole microseconds per beat (140 BPM comes back as
    # 140.00014), so the tempo is rounded back to the tune's own value.
    return replace(
        lead_sheet,
        title=title or "Untitled",
        key=_tune_key(abc_text),
        tempo_bpm=round(lead_sheet.tempo_bpm, 3),
    )


def _tune_key(abc_text: str) -> str:
    """The key of the tune's `K:` line, as music21 names it ("G major"); "" for none.

    >>> _tune_key("X:1\\nK:Ador\\n"), _tune_key("X:1\\nK:Bb\\n"), _tune_key("X:1\\nK:none\\n")
    ('A dorian', 'B- major', '')
    """
    field = next((line for line in abc_text.splitlines() if line.startswith("K:")), "")
    if not field or field[2:].strip().lower().startswith("none"):
        return ""
    metadata = abcFormat.ABCMetadata(field)
    metadata.preParse()
    try:
        found = metadata.getKeySignatureObject()
    except Exception:  # an odd K: field: write the lead sheet without a key signature
        return ""
    return f"{found.tonicPitchNameWithCase} {found.mode}" if isinstance(found, key.Key) else ""


# --- Writing a collection ---


def comment_lines(paragraphs: Iterable[str]) -> list[str]:
    """Wrap provenance paragraphs into ABC comment lines (without "%"), keeping URLs whole.

    >>> comment_lines(['Source: "x" (file y).'])
    ["Source: 'x' (file y)."]
    """
    lines = []
    for paragraph in paragraphs:
        # A double quote would open a chord symbol in some ABC readers, so comments avoid it.
        lines += textwrap.wrap(
            paragraph.replace('"', "'"),
            COMMENT_WIDTH,
            break_long_words=False,
            break_on_hyphens=False,
        )
    return lines


def sheet_facts(lead_sheet: LeadSheet) -> dict:
    """The facts the browser shows for an ABC lead sheet: key, tempo, meter and bars."""
    return {
        "key": lead_sheet.key or estimate_key(pitch_class_weights(lead_sheet)),
        "tempo_bpm": round(lead_sheet.tempo_bpm, 3),
        "meter": str(lead_sheet.bars[0].meter),
        "n_bars": len(lead_sheet.bars),
    }


def skip_reason(error: Exception) -> str:
    """A failure's reason without its bar number, so failures can be counted by kind.

    >>> skip_reason(ValueError("bar 0: the meter 3/2 is not supported; supported meters: 2/2"))
    'the meter 3/2 is not supported'
    """
    return re.sub(r"^bar \d+( \([^)]*\))?: ", "", short_reason(error))


def abc_route(source: str, song_id: str) -> dict:
    """The route of a committed lead sheet: its repository path and the tune's place in it.

    >>> abc_route("nottingham", "jigs-1")
    {'abc': 'data/catalog/abc/nottingham/jigs-1.abc', 'tune': 0}
    """
    return {"abc": (ABC_ROOT / source / f"{song_id}.abc").as_posix(), "tune": 0}


def _fresh_folder(folder: Path) -> None:
    """Empty a collection folder of its lead sheets, so a rerun leaves no stale file."""
    folder.mkdir(parents=True, exist_ok=True)
    for stale in folder.glob("*.abc"):
        stale.unlink()


def _parallel(function: Callable, jobs: Sequence, workers: int) -> list:
    """Run `function` on every job, in order; a runaway job gives a reason string instead."""
    calls = [(function, job) for job in jobs]
    return list(parallel_map(_guarded_call, calls, workers, chunksize=4))


def _guarded_call(call: tuple[Callable, object]):
    function, job = call
    return guarded(function, job, lambda reason: reason)


def _count(skipped: dict[str, int], reason: str) -> None:
    skipped[reason] = skipped.get(reason, 0) + 1


# --- Public-domain MPB songs ---

PUBLIC_DOMAIN_ENVELOPE = {
    "source": "public-domain",
    "name": "Public domain",
    "home": MPB_HOME,
    "license": "Public domain in Brazil: every author died in 1955 or earlier (life + 70 years, "
    "Lei 9.610/98 art. 41), checked on Wikidata (data/catalog/authors.json)",
    "credit": "Song list and MIDI sequences: Beatriz Kauffmann's Web Site "
    "(https://www.beakauffmann.com/); death years: Wikidata",
    "note": "ABC lead sheets reduced from the MIDI sequences of public-domain MPB songs: one "
    "melody, the detected chords, one section. The sequences' own arrangements are not kept.",
    "generated": "uv run src/main.py catalog public-domain --dataset <local MPB study copy>",
}


def write_public_domain(
    dataset_dir: Path | str,
    authors_path: Path | str,
    out_dir: Path | str,
    catalog_out: Path | str,
    workers: int = 1,
) -> tuple[list[dict], dict[str, int]]:
    """Write the lead sheets of the MPB songs whose every author is in the public domain.

    Each file of the local study copy is analyzed and reduced exactly as `catalog analyze`
    does, so the lead sheet equals what the song server would serve. `catalog analyze` leaves
    these songs out of `mpb.json`, so each song is listed once. Returns the catalog entries and
    the number of songs skipped per reason.
    """
    dataset_dir = Path(dataset_dir)
    authors = read_authors(authors_path)
    rows = [
        row
        for row in read_dataset(dataset_dir)
        if not row.missing and song_is_public_domain(row.composers, authors)
    ]
    out_dir = Path(out_dir)
    _fresh_folder(out_dir)
    jobs = [(row, dataset_dir / row.path, _credits(row.composers, authors)) for row in rows]
    entries, skipped = [], {}
    for row, result in zip(rows, _parallel(_public_domain_abc, jobs, workers), strict=True):
        if isinstance(result, str):
            _count(skipped, result)
            continue
        text, facts = result
        (out_dir / f"{row.song_id}.abc").write_text(text, encoding="utf-8")
        entries.append(
            mpb_entry(row, facts)
            | {
                "source": "public-domain",
                "license": "public-domain",
                "seed": sprite_seed("public-domain", row.song_id),
                "route": abc_route("public-domain", row.song_id),
            }
        )
    write_catalog_file(catalog_out, PUBLIC_DOMAIN_ENVELOPE, entries)
    return entries, skipped


def _credits(composers: str, authors: Mapping[str, AuthorRecord]) -> str:
    return "; ".join(
        f"{name} (died {authors[name].death_year}, Wikidata {authors[name].qid})"
        for name in split_composers(composers)
    )


def _public_domain_abc(job: tuple[DatasetRow, Path, str]) -> tuple[str, dict] | str:
    """Return (ABC text, facts) of one public-domain song, or the reason it was skipped."""
    row, path, credits = job
    facts, lead_sheet = analyze_and_reduce(path, row.midi_url)
    if lead_sheet is None:
        return skip_reason(ValueError(facts["error"]))
    bars = facts["bars"]
    comments = comment_lines(
        [
            f"{row.title}, by {row.composers}, as performed by {row.performer}.",
            "License: public domain in Brazil. Every author died 70 or more full years ago "
            f"(life + 70 years, Lei 9.610/98 art. 41): {credits}.",
            "This lead sheet is the project's reduction of a fan-made MIDI sequence: the melody "
            "of one track, the chords detected in the other tracks, one section. The sequence's "
            "own arrangement is not kept.",
            f"Source: {row.page_url} (file {row.midi_url}, sha256 {facts['sha256']}), from "
            f"Beatriz Kauffmann's Web Site. Melody track {facts['melody_track']}, bars "
            f"{bars[0]}-{bars[1]} (0-based, end excluded), section A at bar 0.",
            "Written by: uv run src/main.py catalog public-domain --dataset <local MPB study copy>",
        ]
    )
    try:
        return checked_abc(replace(lead_sheet, title=row.title), comments), facts
    except ValueError as error:
        return skip_reason(error)


# --- Nottingham ---

NOTTINGHAM_ENVELOPE = {
    "source": "nottingham",
    "name": "Nottingham Music Database",
    "home": NOTTINGHAM_HOME,
    "license": "GPL-3.0 (data/catalog/abc/nottingham/LICENSE.md)",
    "credit": "Nottingham Music Database (http://abc.sourceforge.net/NMD/), cleaned by Jukedeck "
    "(https://github.com/jukedeck/nottingham-dataset), GPL-3.0",
    "note": "ABC lead sheets reduced from the cleaned folk tunes: repeats written out, chords "
    "from the tunes' chord symbols, one section. Each file names its source tune.",
    "generated": "uv run src/main.py catalog nottingham",
}


# The Nottingham tunes people know (most of the 1,000 are local dance tunes nobody lists by name).
# Matched on the T: title, lower case; the first tune of a title is kept.
NOTTINGHAM_FAMOUS = frozenset(
    {
        "all those endearing young charms",
        "arkensas traveller",
        "blaydon races",
        "blue bells of scotland",
        "bonnie dundee",
        "cock of the north",
        "dashing white sergeant",
        "drunken sailor",
        "fisher's hornpipe",
        "irish washerwoman",
        "john peel",
        "keel row",
        "oh dear, what can the matter be",
        "oh susanna",
        "over the hills",
        "sailor's hornpipe",
        "she'll be coming round the mountain",
        "the minstrel boy",
        "turkey in the straw",
    }
)


def _tune_title(tune: str) -> str:
    """The lower-case title of a tune (its first `T:` line)."""
    match = re.search(r"^T:\s*(.+?)\s*$", tune, re.MULTILINE)
    return match.group(1).lower() if match else ""


def write_nottingham(
    source_dir: Path | str,
    out_dir: Path | str,
    catalog_out: Path | str,
    workers: int = 1,
    only_titles: Collection[str] | None = None,
) -> tuple[list[dict], dict[str, int]]:
    """Write one lead sheet per Nottingham tune that the arranger can read, and the license.

    `only_titles` keeps just the tunes with those lower-case titles (the first of each title);
    None keeps every tune. Returns the catalog entries and the number of tunes skipped per reason.
    """
    source_dir, out_dir = Path(source_dir), Path(out_dir)
    jobs, seen = [], set()
    for path in sorted((source_dir / "ABC_cleaned").glob("*.abc")):
        sha256 = file_sha256(path)
        for number, tune in split_tunes(path.read_text(encoding="latin-1")):
            title = _tune_title(tune)
            if only_titles is not None and (title not in only_titles or title in seen):
                continue
            seen.add(title)
            jobs.append((path.name, number, tune, sha256))
    _fresh_folder(out_dir)
    shutil.copyfile(source_dir / "LICENSE.md", out_dir / "LICENSE.md")
    entries, skipped = [], {}
    for (file_name, number, _, _), result in zip(
        jobs, _parallel(_nottingham_abc, jobs, workers), strict=True
    ):
        if isinstance(result, str):
            _count(skipped, result)
            continue
        text, lead_sheet = result
        song_id = f"{Path(file_name).stem}-{number}"
        (out_dir / f"{song_id}.abc").write_text(text, encoding="utf-8")
        entries.append(
            {
                "id": song_id,
                "source": "nottingham",
                "t": lead_sheet.title,
                "c": "",
                "u": f"{NOTTINGHAM_HOME}/blob/master/ABC_cleaned/{file_name}",
                "license": "GPL-3.0",
                "seed": sprite_seed("nottingham", song_id),
                "route": abc_route("nottingham", song_id),
                "facts": sheet_facts(lead_sheet),
            }
        )
    write_catalog_file(catalog_out, NOTTINGHAM_ENVELOPE, entries)
    return entries, skipped


def _nottingham_abc(job: tuple[str, int, str, str]) -> tuple[str, LeadSheet] | str:
    """Reduce one tune; return (ABC text, lead sheet), or the reason it was skipped."""
    file_name, number, tune, sha256 = job
    try:
        lead_sheet = reduce_tune(tune)
        comments = comment_lines(
            [
                f"{lead_sheet.title}, from the Nottingham Music Database as cleaned by Jukedeck: "
                f"ABC_cleaned/{file_name}, tune X: {number} ({NOTTINGHAM_HOME}; source file "
                f"sha256 {sha256}).",
                "License: GPL-3.0, see LICENSE.md in this folder.",
                "This lead sheet is the project's reduction of the tune: repeats written out, the "
                "pickup padded to a full bar, chords detected from the tune's chord symbols, one "
                "section.",
                "Written by: uv run src/main.py catalog nottingham",
            ]
        )
        return checked_abc(lead_sheet, comments), lead_sheet
    except ValueError as error:
        return skip_reason(error)


# --- PDMX (research R12) ---

PDMX_ENVELOPE = {
    "source": "pdmx",
    "name": "PDMX",
    "home": PDMX_RECORD,
    "license": "CC BY 4.0 (the dataset); each score public domain (PDM) or CC0 "
    "(data/catalog/abc/pdmx/NOTICE.md)",
    "credit": "PDMX: A Large-Scale Public Domain MusicXML Dataset for Symbolic Music Processing, "
    f"by Phillip Long, Zachary Novack, Julian McAuley and Taylor Berg-Kirkpatrick (doi {PDMX_DOI}),"
    " CC BY 4.0",
    "note": "ABC lead sheets reduced from PDMX's MIDI files of scores whose composer died in 1955 "
    "or earlier: one melody, the detected chords, at most 64 bars.",
    "generated": "uv run src/main.py catalog pdmx --limit 300",
}

PDMX_NOTICE = f"""# PDMX lead sheets

The lead sheets in this folder are reduced from MIDI files of PDMX:

> Phillip Long, Zachary Novack, Julian McAuley and Taylor Berg-Kirkpatrick. *PDMX: A
> Large-Scale Public Domain MusicXML Dataset for Symbolic Music Processing.* Zenodo record
> 15571083, doi:{PDMX_DOI} ({PDMX_RECORD}).

PDMX is licensed under the Creative Commons Attribution 4.0 International license (CC BY 4.0,
https://creativecommons.org/licenses/by/4.0/). Each score in it was published on MuseScore under
the Public Domain Mark or CC0, as its `license` field records.

Changes: the project keeps only scores of the `no_license_conflict` subset that are the best
unique arrangement of their song, 8 to 256 bars long, and whose composer died in 1955 or earlier
according to Wikidata (`data/catalog/authors.json`). Each file is reduced to a lead sheet (one
melody, the detected chords, at most 64 bars) and names its source file, its SHA-256 and its
license in its `%` header.

Written by: `uv run src/main.py catalog pdmx --limit 300`.
"""


def _field(row: Mapping[str, str | None], column: str) -> str:
    """A PDMX.csv field, "" when missing (the file writes a missing value as NA)."""
    value = row.get(column) or ""
    return "" if value in ("NA", "nan") else value


def _truthy(value: str) -> bool:
    return value.strip().lower() == "true"


def _number(value: str) -> float:
    try:
        return float(value)
    except ValueError:
        return 0.0


def pdmx_candidates(csv_path: Path | str) -> list[dict]:
    """Rows of PDMX.csv that pass the license, uniqueness and length filter, most viewed first.

    Kept: the `no_license_conflict` subset, the best unique arrangement of each song, 8 to 256
    bars, licensed PDM or CC0, with a MIDI file. Ranked by views, then favorites, then path: the
    scores people open most are the songs people know.
    """
    csv.field_size_limit(1 << 24)  # some PDMX rows hold long tag lists
    low, high = PDMX_BARS
    with Path(csv_path).open(encoding="utf-8", newline="") as handle:
        rows = [
            {column: _field(row, column) for column in PDMX_COLUMNS}
            for row in csv.DictReader(handle)
            if _truthy(row["subset:no_license_conflict"])
            and _truthy(row["is_best_unique_arrangement"])
            and low <= _number(row["song_length.bars"]) <= high
            and row["license"] in PDMX_LICENSES
            and _field(row, "mid")
        ]
    return sorted(
        rows, key=lambda row: (-_number(row["n_views"]), -_number(row["n_favorites"]), row["path"])
    )


def select_pdmx_rows(
    csv_path: Path | str, authors: Mapping[str, AuthorRecord], limit: int
) -> list[dict]:
    """The first `limit` candidates (see `pdmx_candidates`) whose composers are all free.

    PDMX's `is_original` flag is not trusted: it marks covers of protected songs too, so a
    score without a resolvable public-domain composer is left out.
    """
    chosen, titles = [], set()
    for row in pdmx_candidates(csv_path):
        title = (row["song_name"] or row["title"]).strip().lower()
        if title in titles:
            continue  # the most viewed arrangement of a title is the one listed
        if row["composer_name"] and song_is_public_domain(row["composer_name"], authors):
            titles.add(title)
            chosen.append(row)
            if len(chosen) >= limit:
                break
    return chosen


def clean_composer(name: str) -> str:
    """A composer's name without the life dates that uploaders write after it.

    >>> clean_composer("Erik Satie(18661925)")
    'Erik Satie'
    >>> clean_composer("Johann Sebastian Bach (1685-1750)")
    'Johann Sebastian Bach'
    >>> clean_composer("Tchaikovsky")
    'Tchaikovsky'
    """
    return re.sub(r"\s*\(?\d{4}.*$", "", name).strip()


def pdmx_author_names(
    csv_path: Path | str, limit: int, resolve: Callable[[Iterable[str]], list[AuthorRecord]]
) -> list[AuthorRecord]:
    """Resolve the composers of PDMX candidates, best rated first, until `limit` tunes are free.

    Names are resolved about 50 at a time (one Wikidata batch), so the walk stops soon after
    `select_pdmx_rows` would have enough tunes.
    """
    known: dict[str, AuthorRecord] = {}
    waiting: list[dict] = []
    free = 0

    def settle() -> int:
        names = [n for row in waiting for n in split_composers(row["composer_name"])]
        for record in resolve([n for n in dict.fromkeys(names) if n not in known]):
            known[record.name] = record
        count = sum(song_is_public_domain(row["composer_name"], known) for row in waiting)
        waiting.clear()
        return count

    pending_names: set[str] = set()
    for row in pdmx_candidates(csv_path):
        if not row["composer_name"]:
            continue
        waiting.append(row)
        pending_names.update(n for n in split_composers(row["composer_name"]) if n not in known)
        if len(pending_names) >= 50:
            free += settle()
            pending_names.clear()
            if free >= limit:
                break
    if waiting:
        settle()
    return list(known.values())


def extract_pdmx_midi(source_dir: Path, members: Iterable[str]) -> None:
    """Extract the named MIDI files of `mid.tar.gz` into `source_dir`, once (they are cached)."""
    wanted = {member for member in members if not (source_dir / member).exists()}
    if not wanted:
        return
    with tarfile.open(source_dir / "mid.tar.gz", "r:gz") as archive:
        for info in archive:
            if info.name in wanted and info.isfile():
                target = source_dir / info.name
                target.parent.mkdir(parents=True, exist_ok=True)
                extracted = archive.extractfile(info)
                if extracted is not None:
                    target.write_bytes(extracted.read())


def write_pdmx(
    source_dir: Path | str,
    authors_path: Path | str,
    out_dir: Path | str,
    catalog_out: Path | str,
    limit: int = PDMX_LIMIT,
    workers: int = 1,
) -> tuple[list[dict], dict[str, int]]:
    """Write the lead sheets of the PDMX subset (research R12), with the CC BY notice.

    Returns the catalog entries and the number of tunes skipped per reason.
    """
    source_dir, out_dir = Path(source_dir), Path(out_dir)
    authors = read_authors(authors_path)
    rows = select_pdmx_rows(source_dir / "PDMX.csv", authors, limit)
    members = [row["mid"].removeprefix("./") for row in rows]
    extract_pdmx_midi(source_dir, members)
    _fresh_folder(out_dir)
    (out_dir / "NOTICE.md").write_text(PDMX_NOTICE, encoding="utf-8")
    jobs = [
        (row, source_dir / member, member, _credits(row["composer_name"], authors), limit)
        for row, member in zip(rows, members, strict=True)
    ]
    entries, skipped = [], {}
    for (row, _, member, _, _), result in zip(
        jobs, _parallel(_pdmx_abc, jobs, workers), strict=True
    ):
        if isinstance(result, str):
            _count(skipped, result)
            continue
        text, facts = result
        song_id = Path(member).stem[:16]
        (out_dir / f"{song_id}.abc").write_text(text, encoding="utf-8")
        entries.append(
            {
                "id": song_id,
                "source": "pdmx",
                "t": row["song_name"] or row["title"],
                "c": clean_composer(row["composer_name"]),
                "p": row["artist_name"],
                "u": PDMX_RECORD,
                "license": PDMX_LICENSES[row["license"]],
                "seed": sprite_seed("pdmx", song_id),
                "route": abc_route("pdmx", song_id),
                "facts": facts,
            }
        )
    write_catalog_file(catalog_out, PDMX_ENVELOPE, entries)
    return entries, skipped


def _pdmx_abc(job: tuple[dict, Path, str, str, int]) -> tuple[str, dict] | str:
    row, path, member, credits, limit = job
    if not path.is_file():
        return "the MIDI file is not in mid.tar.gz"
    facts, lead_sheet = analyze_and_reduce(path, member)
    if lead_sheet is None:
        return re.sub(r"^bar \d+( \([^)]*\))?: ", "", facts["error"])
    title = row["song_name"] or row["title"] or Path(member).stem
    bars = facts["bars"]
    license_name = PDMX_LICENSES[row["license"]]
    comments = comment_lines(
        [
            f"{title}, by {row['composer_name']}. Score published on MuseScore (artist: "
            f"{row['artist_name'] or 'not given'}), {license_name} "
            f"({row['license_url'] or 'no license URL'}).",
            f"Composer in the public domain (died 70 or more full years ago): {credits}.",
            f"From PDMX (Long, Novack, McAuley and Berg-Kirkpatrick), {PDMX_RECORD}, doi "
            f"{PDMX_DOI}, CC BY 4.0; see NOTICE.md in this folder.",
            f"Reduced from {member} (sha256 {facts['sha256']}): melody track "
            f"{facts['melody_track']}, bars {bars[0]}-{bars[1]} (0-based, end excluded), "
            "section A at bar 0.",
            f"Written by: uv run src/main.py catalog pdmx --limit {limit}",
        ]
    )
    try:
        return checked_abc(replace(lead_sheet, title=title), comments), facts
    except ValueError as error:
        return skip_reason(error)


# --- Examples ---

EXAMPLES_ENVELOPE = {
    "source": "examples",
    "name": "Examples",
    "home": "https://github.com/GiowGiow/nes-genetic-arranger",
    "license": "Two traditional tunes (public domain) and six academic reductions of fan-made MIDI "
    "songs (data/sources.json)",
    "credit": "The project's own lead sheets; the MIDI songs' sources are named in "
    "data/sources.json and in each lead sheet's header",
    "note": "The lead sheets committed in data/leadsheets/, the inputs of the listening page's "
    "samples.",
    "generated": "uv run src/main.py catalog examples",
}


def write_examples(sources_path: Path | str, out: Path | str) -> list[dict]:
    """Write the Examples card: the two traditional tunes and the songs of the sources manifest.

    The same eight examples, in the same order (`order`), as `arranger/src/ui/examples.js`.
    Facts are read from each committed lead sheet; the MIDI songs carry the samples' stopping
    limits (`max_generations` 4000, `stagnation_window` 400) as `facts.overrides`.
    """
    songs = [
        (tune_id, title, origin, "", None, f"data/leadsheets/{tune_id}.abc", "public-domain", {})
        for tune_id, title, origin in TRADITIONAL_EXAMPLES
    ]
    songs += [
        (
            song.id,
            song.title,
            ", ".join(song.composers),
            song.artist,
            song.page_url,
            song.abc.as_posix(),
            "all-rights-reserved",
            dict(MIDI_SONG_OVERRIDES),
        )
        for song in load_sources(sources_path)
    ]
    root = Path(sources_path).resolve().parent.parent  # data/sources.json is in the repository
    entries = []
    for order, (
        song_id,
        title,
        composers,
        performer,
        page,
        abc,
        license_name,
        overrides,
    ) in enumerate(songs):
        lead_sheet = read_lead_sheet_text((root / abc).read_text(encoding="utf-8"), PHRASE_LENGTH)
        entry = {"id": song_id, "source": "examples", "t": title, "c": composers, "p": performer}
        if page:
            entry["u"] = page
        facts = sheet_facts(lead_sheet) | ({"overrides": overrides} if overrides else {})
        entries.append(
            entry
            | {
                "license": license_name,
                "seed": sprite_seed("examples", song_id),
                "order": order,
                "route": {"abc": abc, "tune": 0},
                "facts": facts,
            }
        )
    write_catalog_file(out, EXAMPLES_ENVELOPE, entries)
    return entries


# --- Commands ---


def add_collection_parsers(catalog_commands: argparse._SubParsersAction) -> None:
    """Add `catalog public-domain`, `nottingham`, `pdmx` and `examples` (contracts/cli.md)."""
    public = catalog_commands.add_parser(
        "public-domain", help="write the lead sheets of the public-domain MPB songs"
    )
    public.add_argument("--dataset", type=Path, required=True, help="local MPB study copy")
    public.add_argument("--authors", type=Path, default=DEFAULT_AUTHORS)
    public.add_argument("--out-dir", type=Path, default=ABC_ROOT / "public-domain")
    public.add_argument("--out", type=Path, default=CATALOG_ROOT / "public-domain.json")
    public.add_argument("--workers", type=int, default=1)
    public.set_defaults(handler=run_public_domain)

    nottingham = catalog_commands.add_parser(
        "nottingham", help="write the Nottingham folk tunes as lead sheets (GPL-3.0)"
    )
    nottingham.add_argument("--source", type=Path, default=Path("data/raw/nottingham"))
    nottingham.add_argument("--out-dir", type=Path, default=ABC_ROOT / "nottingham")
    nottingham.add_argument("--out", type=Path, default=CATALOG_ROOT / "nottingham.json")
    nottingham.add_argument("--workers", type=int, default=1)
    nottingham.add_argument(
        "--all", action="store_true", help="write every tune, not only the well-known ones"
    )
    nottingham.set_defaults(handler=run_nottingham)

    pdmx = catalog_commands.add_parser("pdmx", help="write the PDMX subset as lead sheets")
    pdmx.add_argument("--source", type=Path, default=Path("data/raw/pdmx"))
    pdmx.add_argument("--authors", type=Path, default=DEFAULT_AUTHORS)
    pdmx.add_argument(
        "--limit",
        type=int,
        default=PDMX_LIMIT,
        help=f"tunes to keep, the most viewed (default {PDMX_LIMIT})",
    )
    pdmx.add_argument("--out-dir", type=Path, default=ABC_ROOT / "pdmx")
    pdmx.add_argument("--out", type=Path, default=CATALOG_ROOT / "pdmx.json")
    pdmx.add_argument("--workers", type=int, default=1)
    pdmx.set_defaults(handler=run_pdmx)

    examples = catalog_commands.add_parser(
        "examples", help="write the Examples card from data/sources.json"
    )
    examples.add_argument("--sources", type=Path, default=Path("data/sources.json"))
    examples.add_argument("--out", type=Path, default=CATALOG_ROOT / "examples.json")
    examples.set_defaults(handler=run_examples)


def _report(entries: Sequence[dict], skipped: Mapping[str, int], out: Path) -> None:
    print(f"{len(entries)} lead sheets, {sum(skipped.values())} tunes skipped")
    kinds: dict[str, int] = {}
    for reason, count in skipped.items():
        kind = re.sub(r"\d+(\.\d+)?", "N", reason)  # count by kind, whatever the bar or time
        kinds[kind] = kinds.get(kind, 0) + count
    for kind, count in sorted(kinds.items(), key=lambda item: (-item[1], item[0]))[:10]:
        print(f"  {count:5d}  {kind}")
    print(out)


def run_public_domain(args: argparse.Namespace) -> list[dict]:
    """Write the public-domain MPB lead sheets and their catalog."""
    entries, skipped = write_public_domain(
        args.dataset, args.authors, args.out_dir, args.out, args.workers
    )
    _report(entries, skipped, args.out)
    return entries


def run_nottingham(args: argparse.Namespace) -> list[dict]:
    """Write the Nottingham lead sheets, the license and their catalog."""
    entries, skipped = write_nottingham(
        args.source,
        args.out_dir,
        args.out,
        args.workers,
        None if args.all else NOTTINGHAM_FAMOUS,
    )
    _report(entries, skipped, args.out)
    return entries


def run_pdmx(args: argparse.Namespace) -> list[dict]:
    """Write the PDMX lead sheets, the notice and their catalog."""
    entries, skipped = write_pdmx(
        args.source, args.authors, args.out_dir, args.out, args.limit, args.workers
    )
    _report(entries, skipped, args.out)
    return entries


def run_examples(args: argparse.Namespace) -> list[dict]:
    """Write the Examples catalog."""
    entries = write_examples(args.sources, args.out)
    print(f"{len(entries)} examples")
    print(args.out)
    return entries
