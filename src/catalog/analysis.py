"""Analysis facts of a MIDI file: what the catalog records so a song opens in one click.

A catalog song that is a multi-track MIDI file must be reduced to a lead sheet before it can be
arranged, and the reduction needs choices: which track carries the melody, which bars to read,
where the sections start. In the app a visitor makes them by hand. For a catalog of thousands of
files, this module makes them once, offline, and records them as *analysis facts*
(data-model.md; research R13):

- **Melody track**: a port of the app's ranking (`describeTracks`, `rankMelodyTracks` in
  `arranger/src/core/midi-song.js`). A track scores its single notes (the notes that overlap no
  other note of the track), ×1.5 for a vocal name ("voz", "melody", "lead"…) and ×0.2 when its
  mean pitch lies outside the singing range (55–84). Drums never carry the melody.
- **Bars**: from the first bar that holds a pitched note, at most 64 bars, counted on the same
  beat grid the reader chooses ("auto": the file's own ticks when the drums fit them).
- **Sections**: one section "A"; phrases of 4 bars.
- **Key**: the lead sheet itself has no key (a MIDI file does not say it reliably), so the key
  shown in the browser is estimated: the Krumhansl–Kessler key profile (Krumhansl 1990) that
  correlates best with how long each pitch class sounds in the melody and the chords.
- **Tempo, meter, bar count, drums** come from the reduction itself; the SHA-256 is of the exact
  bytes, so the song server can refuse a file that changed at its source.

Facts never hold notes: the catalog of copyrighted songs keeps metadata, links and these
measurements only (constitution, "Third-party material"). A file the reader refuses is recorded
with a short `error` instead, and the browser lists it as "cannot be arranged".

`write_mpb_catalog` applies this to the local study copy of the MPB MIDI files and writes
`arranger/data/catalog/mpb.json` (`uv run src/main.py catalog analyze --dataset <dir>`). Songs
whose authors are all in the public domain move to the "Public domain" card, so the commands run
in this order: `catalog analyze`, `catalog authors` (death years, from the composers of both
cards), `catalog public-domain`, then `catalog analyze` again, which now leaves those songs out.
"""

import argparse
import csv
import math
import multiprocessing
import re
import resource
import signal
from collections.abc import Callable, Iterator, Mapping, Sequence
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np
import pretty_midi

from catalog.authors import AuthorRecord, read_authors, song_is_public_domain
from catalog.cards import sprite_seed, write_catalog_file
from leadsheet.abc_reader import read_lead_sheet_text
from leadsheet.abc_writer import lead_sheet_to_abc
from leadsheet.midi_reader import (
    FILE_GRID_MIN_STRENGTH,
    GRID,
    MapBar,
    _grid_excerpt,
    _whole_beats,
    bar_map,
    estimate_beat_grid,
    excerpt_bars,
    grid_strength,
    main_meter,
    read_lead_sheet_midi,
)
from leadsheet.model import LeadSheet
from leadsheet.sources import file_sha256

__all__ = ["sprite_seed"]  # re-exported: every catalog writer seeds sprites the same way

MAX_EXCERPT_BARS = 64
PHRASE_LENGTH = 4
MIDI_SONG_OVERRIDES = {"max_generations": 4000, "stagnation_window": 400}
SINGING_RANGE = (55, 84)  # mean MIDI pitch of a sung line, as the app ranks tracks
MELODY_NAME = re.compile(r"voc|voz|melod|lead|canto|vocal|melody", re.IGNORECASE)
MAX_ERROR_LENGTH = 120
WORKER_MEMORY_BYTES = 3 * 1024**3  # address space per worker process
FILE_SECONDS = 120  # longest reduction of one file before it is given up
WORKER_CHUNKS = 25  # chunks of jobs per worker before its pool is replaced by a fresh one

# Krumhansl-Kessler probe-tone profiles, from the tonic up by semitones.
MAJOR_PROFILE = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88)
MINOR_PROFILE = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)
# Tonic names as music21 writes keys (the lead sheet's `key`): upper case for major.
MAJOR_TONICS = ("C", "D-", "D", "E-", "E", "F", "F#", "G", "A-", "A", "B-", "B")
MINOR_TONICS = ("c", "c#", "d", "e-", "e", "f", "f#", "g", "g#", "a", "b-", "b")

MPB_SOURCE = "mpb"
MPB_HOME = "https://www.beakauffmann.com/"
MPB_ENVELOPE = {
    "source": MPB_SOURCE,
    "name": "MPB",
    "home": MPB_HOME,
    "license": "All Rights Reserved (the catalog site); metadata, links and analysis facts only",
    "credit": "Beatriz Kauffmann's Web Site (https://www.beakauffmann.com/): song list and MIDI "
    "sequences",
    "note": "Titles, composers, performers, links and facts measured on each MIDI file (melody "
    "track, bars, key, tempo, meter, SHA-256). No notes: the song server reads the MIDI file "
    "from the catalog site when a visitor opens a song, and keeps no permanent copy.",
    "generated": "uv run src/main.py catalog analyze --dataset <local MPB study copy>",
}


@dataclass(frozen=True)
class TrackSummary:
    """One instrument of a MIDI file, summarized for choosing the melody (port of the app's).

    Attributes:
        index: pretty_midi instrument index (the CLI's `melody_track`).
        name: track name.
        program: General MIDI program.
        is_drum: True for a percussion track.
        note_count: number of notes.
        lowest: lowest MIDI pitch (0 without notes).
        highest: highest MIDI pitch (0 without notes).
        mean_pitch: mean MIDI pitch (NaN without notes).
        polyphony: share of notes that overlap another note of the track (0-1).
    """

    index: int
    name: str
    program: int
    is_drum: bool
    note_count: int
    lowest: int
    highest: int
    mean_pitch: float
    polyphony: float


def overlap_share(notes: Sequence[pretty_midi.Note]) -> float:
    """Return the share of notes that overlap another note of the same list.

    Two notes overlap when one starts before the other ends and ends after the other starts
    (the app's pairwise test). With the notes sorted by start, each test becomes a range
    question answered with sorted searches, so a track of long held notes stays fast.

    >>> N = pretty_midi.Note
    >>> overlap_share([N(90, 60, 0.0, 1.0), N(90, 64, 0.5, 1.0), N(90, 67, 1.0, 2.0)])
    0.6666666666666666
    """
    if not notes:
        return 0.0
    starts = np.array([note.start for note in notes], dtype=float)
    order = np.argsort(starts, kind="stable")
    starts = starts[order]
    ends = np.array([note.end for note in notes], dtype=float)[order]
    count = len(starts)
    index = np.arange(count)
    sounding = ends > starts
    # running[k] = how many notes among the first k have a positive length
    running = np.concatenate([[0], np.cumsum(sounding)])
    group_start = np.searchsorted(starts, starts, side="left")
    group_end = np.searchsorted(starts, starts, side="right")
    # As the earlier note: a later note starts before this one ends. One that starts strictly
    # later always ends after this start; one that starts together must have a length.
    starts_before_end = np.searchsorted(starts, ends, side="left")
    later_after = starts_before_end > np.maximum(group_end, index + 1)
    together_end = np.minimum(group_end, starts_before_end)
    later_together = running[np.maximum(together_end, index + 1)] - running[index + 1] > 0
    # As the later note: an earlier-starting note ends after this start, or a note that starts
    # together sounds while this one sounds too.
    latest_end = np.concatenate([[-np.inf], np.maximum.accumulate(ends)])
    earlier_holds = latest_end[group_start] > starts
    earlier_together = sounding & (running[index] - running[group_start] > 0)
    flags = later_after | later_together | earlier_holds | earlier_together
    return int(flags.sum()) / count


def describe_tracks(midi: pretty_midi.PrettyMIDI) -> list[TrackSummary]:
    """Summarize each instrument of a MIDI file, in pretty_midi order (port of `describeTracks`)."""
    summaries = []
    for index, instrument in enumerate(midi.instruments):
        pitches = [note.pitch for note in instrument.notes]
        summaries.append(
            TrackSummary(
                index=index,
                name=instrument.name,
                program=instrument.program,
                is_drum=instrument.is_drum,
                note_count=len(pitches),
                lowest=min(pitches, default=0),
                highest=max(pitches, default=0),
                mean_pitch=sum(pitches) / len(pitches) if pitches else math.nan,
                polyphony=overlap_share(instrument.notes),
            )
        )
    return summaries


def melody_score(track: TrackSummary) -> float:
    """Return how melody-like a track is: its single notes, weighted by name and range.

    >>> voice = TrackSummary(1, "Voz", 0, False, 200, 60, 74, 67.0, 0.05)
    >>> melody_score(voice)  # 200 notes, 95% single, x1.5 for the vocal name
    285.0
    """
    score = track.note_count * (1 - track.polyphony)
    if MELODY_NAME.search(track.name):
        score *= 1.5
    low, high = SINGING_RANGE
    if track.mean_pitch < low or track.mean_pitch > high:
        score *= 0.2
    return score


def rank_melody_tracks(tracks: Sequence[TrackSummary]) -> list[int]:
    """Return the non-drum track indices from the most to the least melody-like.

    Ties keep track order, as the app's stable sort does.

    >>> strings = TrackSummary(0, "Strings", 0, False, 400, 48, 72, 60.0, 0.9)
    >>> voice = TrackSummary(1, "Voz", 0, False, 200, 60, 74, 67.0, 0.05)
    >>> bass = TrackSummary(2, "Bass", 0, False, 300, 28, 52, 40.0, 0.0)
    >>> rank_melody_tracks([strings, voice, bass])  # scores 40, 285 and 60
    [1, 2, 0]
    """
    pitched = [track for track in tracks if not track.is_drum]
    return [track.index for track in sorted(pitched, key=lambda track: -melody_score(track))]


def estimate_key(weights: Sequence[float]) -> str:
    """Return the key whose Krumhansl-Kessler profile best matches 12 pitch-class weights.

    The weights say how long each pitch class (0 = C) sounds. The result is spelled as music21
    names keys ("C major", "e- minor"); "" when nothing sounds. Ties keep the first key, from C
    major up, majors before minors.

    >>> estimate_key([3, 0, 1, 0, 2, 1, 0, 2.5, 0, 1, 0, 1])
    'C major'
    """
    profile = np.asarray(weights, dtype=float)
    if profile.sum() <= 0 or np.ptp(profile) == 0:
        return ""
    best, best_score = "", -math.inf
    for mode, template, tonics in (
        ("major", MAJOR_PROFILE, MAJOR_TONICS),
        ("minor", MINOR_PROFILE, MINOR_TONICS),
    ):
        for tonic in range(12):
            score = float(np.corrcoef(profile, np.roll(template, tonic))[0, 1])
            if score > best_score + 1e-12:
                best, best_score = f"{tonics[tonic]} {mode}", score
    return best


def pitch_class_weights(lead_sheet: LeadSheet) -> list[float]:
    """Return how long (in beats) each pitch class sounds in the melody and in the chord tones."""
    weights = [0.0] * 12
    for bar in lead_sheet.bars:
        for note in bar.melody:
            weights[note.pitch % 12] += note.duration
        for chord in bar.chords:
            for tone in chord.tones:
                weights[tone] += chord.duration
    return weights


def beat_grid(midi: pretty_midi.PrettyMIDI) -> str | tuple[float, float]:
    """Return the beat grid the reader's "auto" choice takes: "file", or (bpm, downbeat s).

    The file's own ticks are kept when the drum onsets fit them (or there are no drums);
    otherwise the grid is estimated from the recording (see `leadsheet.midi_reader`).
    """
    drum_beats = np.array(
        [
            midi.time_to_tick(note.start) / midi.resolution
            for instrument in midi.instruments
            if instrument.is_drum
            for note in instrument.notes
        ]
    )
    if drum_beats.size == 0 or grid_strength(drum_beats, 60.0) >= FILE_GRID_MIN_STRENGTH:
        return "file"
    bpm, downbeat, _ = estimate_beat_grid(midi, _whole_beats(main_meter(midi)))
    return bpm, downbeat


def noted_bars(midi: pretty_midi.PrettyMIDI, grid: str | tuple[float, float]) -> tuple[int, int]:
    """Return the bars (first, end) from the first to the last that hold a pitched note."""
    if grid == "file":
        _, first, end = excerpt_bars(midi, None)
        return first, end
    bpm, downbeat = grid

    def beats(seconds: float) -> float:
        return (seconds - downbeat) * bpm / 60.0

    _, first, end = _grid_excerpt(midi, main_meter(midi), beats, None)
    return first, end


def check_bar_lines(bars: Sequence[MapBar], first: int = 0) -> None:
    """Refuse an excerpt whose bar lines fall off the sixteenth-note grid.

    A time signature placed a few ticks after a beat moves every later bar line off the grid
    the melody snaps to. Such a lead sheet cannot be written as ABC, and the reader's melody
    split can stop advancing on the float noise of those bar lines, so the file is refused
    before it is read.

    >>> check_bar_lines([MapBar(0.0, 4.0, (4, 4)), MapBar(4.0, 4.0, (4, 4))])
    >>> check_bar_lines([MapBar(0.03125, 4.0, (4, 4))], first=2)  # doctest: +ELLIPSIS
    Traceback (most recent call last):
    ...
    ValueError: bar 2 starts off the sixteenth-note grid (beat 0.03125): a time signature is ...
    """
    for index, bar in enumerate(bars):
        units = bar.start / GRID
        if abs(units - round(units)) > 1e-6:
            raise ValueError(
                f"bar {first + index} starts off the sixteenth-note grid (beat {bar.start:g}): "
                "a time signature is off the beat"
            )


def analyze_midi(path: Path | str, midi_ref: str | None = None) -> dict:
    """Return the analysis facts of a MIDI file (data-model.md, "Analysis facts").

    Args:
        path: the MIDI file.
        midi_ref: where the file comes from, recorded as `midi` (the source URL for MPB, the
            dataset path for PDMX); by default the path itself.

    Returns:
        midi, sha256, melody_track, bars [first, end), sections, key, tempo_bpm, meter, n_bars,
        drums and overrides; or, when the file cannot be reduced, only midi, sha256 and a short
        `error`.
    """
    return analyze_and_reduce(path, midi_ref)[0]


def analyze_and_reduce(
    path: Path | str, midi_ref: str | None = None
) -> tuple[dict, LeadSheet | None]:
    """Return the analysis facts of a MIDI file (see `analyze_midi`) and the lead sheet they give.

    The lead sheet is None when the file cannot be reduced (the facts then hold an `error`).
    """
    path = Path(path)
    facts: dict = {"midi": midi_ref or path.as_posix(), "sha256": file_sha256(path)}
    try:
        melody_track, (first, end), lead_sheet, drums = _reduce(path)
    except (ValueError, OSError, EOFError, IndexError, KeyError) as error:
        return facts | {"error": short_reason(error)}, None
    facts |= {
        "melody_track": melody_track,
        "bars": [first, end],
        "sections": [[0, "A"]],
        "key": estimate_key(pitch_class_weights(lead_sheet)),
        "tempo_bpm": round(lead_sheet.tempo_bpm, 3),
        "meter": str(lead_sheet.bars[0].meter),
        "n_bars": len(lead_sheet.bars),
        "drums": drums,
        "overrides": dict(MIDI_SONG_OVERRIDES),
    }
    return facts, lead_sheet


def reduce_with_facts(path: Path | str, facts: dict, title: str | None = None) -> LeadSheet:
    """Reduce a MIDI file with the options its facts record: the catalog song's lead sheet.

    This is the reduction the song server serves and the public-domain writer commits, so both
    give the same lead sheet for the same file (the beat grid is the reader's "auto" choice).

    Raises:
        ValueError: when the file's SHA-256 differs from the facts (the song changed at its
            source), or when the reader refuses the file.
    """
    digest = file_sha256(path)
    if digest != facts["sha256"]:
        raise ValueError(f"the file has sha256 {digest}, but the catalog expects {facts['sha256']}")
    lead_sheet = read_lead_sheet_midi(
        path,
        facts["melody_track"],
        phrase_length=PHRASE_LENGTH,
        bars=(facts["bars"][0], facts["bars"][1]),
        sections=[(int(bar), str(label)) for bar, label in facts["sections"]],
    )
    return replace(lead_sheet, title=title) if title else lead_sheet


def checked_abc(lead_sheet: LeadSheet, comments: Sequence[str] = ()) -> str:
    """Return the lead sheet as ABC, after checking that the ABC reader reads it back.

    Raises:
        ValueError: "the lead sheet does not read back: <why>" when the reader refuses the
            text or reads another melody.
    """
    text = lead_sheet_to_abc(lead_sheet, PHRASE_LENGTH, comments)
    try:
        again = read_lead_sheet_text(text, PHRASE_LENGTH)
    except ValueError as error:
        raise ValueError(f"the lead sheet does not read back: {error}") from error
    if [bar.melody for bar in again.bars] != [bar.melody for bar in lead_sheet.bars]:
        raise ValueError("the lead sheet does not read back: another melody")
    return text


def short_reason(error: Exception) -> str:
    """Return the first clause of an error message, at most 120 characters.

    >>> short_reason(ValueError("bar 3: the meter 11/16 is not supported; supported meters: 2/2"))
    'bar 3: the meter 11/16 is not supported'
    >>> short_reason(EOFError())
    'EOFError'
    """
    text = str(error).split(";")[0].strip() or type(error).__name__
    return text if len(text) <= MAX_ERROR_LENGTH else text[: MAX_ERROR_LENGTH - 1] + "…"


def _reduce(path: Path) -> tuple[int, tuple[int, int], LeadSheet, bool]:
    """Choose the melody track and bars, reduce, and check the lead sheet can be served as ABC."""
    try:
        midi = pretty_midi.PrettyMIDI(str(path))
    except Exception as error:  # mido and pretty_midi raise many kinds on a damaged file
        raise ValueError(f"unreadable MIDI file ({type(error).__name__})") from error
    ranking = rank_melody_tracks(describe_tracks(midi))
    if not any(not i.is_drum and i.notes for i in midi.instruments):
        raise ValueError("no pitched notes (drums only or empty)")
    melody_track = ranking[0]
    grid = beat_grid(midi)
    first, end = noted_bars(midi, grid)
    bars = (first, min(end, first + MAX_EXCERPT_BARS))
    if grid == "file":
        check_bar_lines(bar_map(midi)[bars[0] : bars[1]], bars[0])
    lead_sheet = read_lead_sheet_midi(
        path, melody_track, phrase_length=PHRASE_LENGTH, bars=bars, grid=grid
    )
    if not any(bar.melody for bar in lead_sheet.bars):
        raise ValueError(
            f"the melody track {melody_track} has no notes in bars {bars[0]}-{bars[1]}"
        )
    checked_abc(lead_sheet)  # the server returns this text, and the app must read it back
    drums = any(instrument.is_drum and instrument.notes for instrument in midi.instruments)
    return melody_track, bars, lead_sheet, drums


# --- The MPB catalog (arranger/data/catalog/mpb.json) ---


@dataclass(frozen=True)
class DatasetRow:
    """One MIDI link of the MPB study copy's `metadata.csv`.

    Attributes:
        song_id: the file name without extension, unique in the catalog (e.g. "aquarela").
        title, composers, performer: as the catalog site writes them.
        page_url, midi_url: the song page and the MIDI link at the site.
        path: the local file, relative to the dataset folder.
        variant, variants: which MIDI link of the song this is, and how many it has.
        missing: True when the link was broken at download time (no file).
    """

    song_id: str
    title: str
    composers: str
    performer: str
    page_url: str
    midi_url: str
    path: str
    variant: int
    variants: int
    missing: bool


def read_dataset(dataset_dir: Path | str) -> list[DatasetRow]:
    """Read the rows of `metadata.csv` in the MPB study copy (see its README for the columns)."""
    with (Path(dataset_dir) / "metadata.csv").open(encoding="utf-8", newline="") as handle:
        return [
            DatasetRow(
                song_id=Path(row["path"]).stem,
                title=row["title"],
                composers=row["composers"],
                performer=row["performer"],
                page_url=row["page_url"],
                midi_url=row["midi_url"],
                path=row["path"],
                variant=int(row["variant"] or 1),
                variants=int(row["variants"] or 1),
                missing=row["error"] == "missing",
            )
            for row in csv.DictReader(handle)
        ]


def mpb_entry(row: DatasetRow, facts: dict | None) -> dict:
    """Return the catalog entry of one MPB MIDI file: metadata, sprite seed, route or error.

    `facts` is None when the file is missing (its link was broken at the site).
    """
    entry = {
        "id": row.song_id,
        "source": MPB_SOURCE,
        "t": row.title,
        "c": row.composers,
        "p": row.performer,
        "u": row.page_url,
        "license": "all-rights-reserved",
        "seed": sprite_seed(MPB_SOURCE, row.song_id),
    }
    if row.variants > 1:
        entry["variant"] = f"{row.variant}/{row.variants}"
    if facts is None:
        entry["facts"] = {"midi": row.midi_url}
        entry["error"] = "the MIDI link is broken at the catalog site"
        return entry
    facts = dict(facts)
    error = facts.pop("error", None)
    if error is None:
        entry["route"] = {"server": f"/songs/mpb/{row.song_id}.abc"}
    entry["facts"] = facts
    if error is not None:
        entry["error"] = error
    return entry


def write_mpb_catalog(
    dataset_dir: Path | str,
    out: Path | str,
    workers: int = 1,
    authors: Mapping[str, AuthorRecord] | None = None,
    log: Callable[[str], None] = print,
) -> list[dict]:
    """Analyze every MIDI file of the MPB study copy and write the catalog file; return entries.

    Args:
        dataset_dir: the study copy (`metadata.csv` and `midi/`).
        out: the catalog file to write, usually `arranger/data/catalog/mpb.json`.
        workers: processes that analyze files in parallel (the result does not depend on it).
        authors: the resolved authors (`data/catalog/authors.json`). A song whose authors are
            all in the public domain, and that can be arranged, is left out: the "Public
            domain" card lists it with its committed lead sheet (`catalog public-domain`).
        log: function that prints one progress line.
    """
    dataset_dir = Path(dataset_dir)
    rows = read_dataset(dataset_dir)
    present = [row for row in rows if not row.missing]
    jobs = [(dataset_dir / row.path, row.midi_url) for row in present]
    analyzed = dict(
        zip((row.song_id for row in present), _analyze_all(jobs, workers, log), strict=True)
    )
    entries = [mpb_entry(row, analyzed.get(row.song_id)) for row in rows]
    if authors is not None:
        entries = [
            entry
            for entry in entries
            if "route" not in entry or not song_is_public_domain(entry["c"], authors)
        ]
    write_catalog_file(out, MPB_ENVELOPE, entries)
    return entries


def parallel_map(function: Callable, jobs: Sequence, workers: int, chunksize: int = 8) -> Iterator:
    """Yield `function(job)` for every job, in order, from `workers` processes capped at 3 GB.

    Python keeps the memory a process once needed, and a few long MIDI files need much more
    than the rest, so the jobs run in batches, each in a fresh pool of processes; the cap turns
    a runaway file into a MemoryError for that file alone. With one worker the jobs run here.
    """
    if workers <= 1:
        yield from map(function, jobs)
        return
    batch = workers * chunksize * WORKER_CHUNKS
    for first in range(0, len(jobs), batch):
        with ProcessPoolExecutor(
            max_workers=workers,
            mp_context=multiprocessing.get_context("spawn"),
            initializer=_cap_memory,
        ) as pool:
            yield from pool.map(function, jobs[first : first + batch], chunksize=chunksize)


def _cap_memory() -> None:
    resource.setrlimit(resource.RLIMIT_AS, (WORKER_MEMORY_BYTES, WORKER_MEMORY_BYTES))


class _TooSlow(Exception):
    pass


def _alarm(signum, frame) -> None:
    raise _TooSlow


def guarded(function: Callable, job, fallback: Callable[[str], object]):
    """Run `function(job)`, turning a run over 120 s or out of memory into `fallback(reason)`.

    A batch over thousands of third-party files must not stop on one that makes the reader
    loop or swell; that file gets a reason instead. Typical files take under 2 s.
    """
    previous = signal.signal(signal.SIGALRM, _alarm)
    signal.alarm(FILE_SECONDS)
    try:
        return function(job)
    except _TooSlow:
        return fallback(f"the reduction took over {FILE_SECONDS} s")
    except MemoryError:
        return fallback("the reduction ran out of memory")
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


def _analyze_one(job: tuple[Path, str]) -> dict:
    path, midi_ref = job
    return guarded(
        lambda pair: analyze_midi(*pair),
        job,
        lambda reason: {"midi": midi_ref, "sha256": file_sha256(path), "error": reason},
    )


def _analyze_all(jobs: Sequence[tuple[Path, str]], workers: int, log) -> list[dict]:
    """Analyze files in order, in `workers` processes, logging every 250 files."""
    results = []
    for done, facts in enumerate(parallel_map(_analyze_one, jobs, workers), start=1):
        results.append(facts)
        _progress(done, len(jobs), log)
    return results


def _progress(done: int, total: int, log) -> None:
    if done % 250 == 0 or done == total:
        log(f"{done}/{total} files analyzed")


def error_counts(entries: Sequence[dict]) -> list[tuple[str, int]]:
    """Count the entries per error reason, bar numbers and times generalized, most common first.

    >>> error_counts([{"error": "bar 3: the meter 1/4 is not supported"},
    ...               {"error": "bar 12: the meter 1/4 is not supported"}, {}])
    [('bar N: the meter 1/4 is not supported', 2)]
    """
    counts: dict[str, int] = {}
    for entry in entries:
        if "error" in entry:
            reason = re.sub(r"\d+(\.\d+)?", "N", entry["error"].split(" (")[0])
            reason = re.sub(r"meter N/N", "meter " + _meter_of(entry["error"]), reason)
            counts[reason] = counts.get(reason, 0) + 1
    return sorted(counts.items(), key=lambda item: (-item[1], item[0]))


def _meter_of(error: str) -> str:
    found = re.search(r"meter (\d+/\d+)", error)
    return found.group(1) if found else "N/N"


def add_analyze_parser(catalog_commands: argparse._SubParsersAction) -> None:
    """Add `catalog analyze --dataset <dir>` (contracts/cli.md)."""
    analyze = catalog_commands.add_parser(
        "analyze", help="write arranger/data/catalog/mpb.json: facts of each MPB MIDI file"
    )
    analyze.add_argument(
        "--dataset", type=Path, required=True, help="local MPB study copy (metadata.csv, midi/)"
    )
    analyze.add_argument("--out", type=Path, default=Path("arranger/data/catalog/mpb.json"))
    analyze.add_argument(
        "--workers", type=int, default=1, help="parallel processes (the output does not change)"
    )
    analyze.add_argument(
        "--authors",
        type=Path,
        default=Path("data/catalog/authors.json"),
        help="resolved authors; when the file exists, public-domain songs are left out",
    )
    analyze.set_defaults(handler=run_analyze)


def run_analyze(args: argparse.Namespace) -> list[dict]:
    """Write the MPB catalog and print how many files can be arranged, and why the others not."""
    authors = read_authors(args.authors) if args.authors.exists() else None
    entries = write_mpb_catalog(args.dataset, args.out, args.workers, authors)
    routed = sum("route" in entry for entry in entries)
    print(f"{len(entries)} entries, {routed} with a server route, {len(entries) - routed} errors")
    for reason, count in error_counts(entries)[:10]:
        print(f"  {count:5d}  {reason}")
    print(args.out)
    return entries
