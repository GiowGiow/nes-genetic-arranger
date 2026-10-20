"""Analysis facts of a MIDI file: the melody-track ranking port and `analyze_midi` (research R13).

The catalog records, for each MIDI file, the facts the song server needs to reduce it to the very
lead sheet the command line gives (melody track, bar range, sections) and the facts the browser
shows before loading (key, tempo, meter, bars, drums). The melody track comes from a Python port
of the app's ranking, so these tests compare it with what the app computes on the same files
(`arranger/tests/fixtures/melody-ranking.json`, written by `make-melody-ranking.mjs`).
"""

import json
from pathlib import Path

import pretty_midi
import pytest

from catalog.analysis import (
    MAX_EXCERPT_BARS,
    MIDI_SONG_OVERRIDES,
    TrackSummary,
    analyze_midi,
    describe_tracks,
    estimate_key,
    melody_score,
    rank_melody_tracks,
    sprite_seed,
)
from leadsheet.sources import file_sha256

REPO = Path(__file__).resolve().parents[2]
RANKING_FIXTURE = REPO / "arranger/tests/fixtures/melody-ranking.json"
SYNTHETIC = REPO / "arranger/tests/fixtures/midi-songs"
FACT_FIELDS = {
    "midi",
    "sha256",
    "melody_track",
    "bars",
    "sections",
    "key",
    "tempo_bpm",
    "meter",
    "n_bars",
    "drums",
    "overrides",
}


def ranking_songs() -> list[dict]:
    return json.loads(RANKING_FIXTURE.read_text(encoding="utf-8"))["songs"]


def summary(index, name, notes, mean, polyphony, is_drum=False) -> TrackSummary:
    return TrackSummary(index, name, 0, is_drum, notes, 40, 90, mean, polyphony)


# --- Melody ranking (port of core/midi-song.js) ---


def test_melody_score_counts_single_notes_and_rewards_a_vocal_name_in_the_singing_range():
    assert melody_score(summary(1, "Voz", 200, 67.0, 0.05)) == pytest.approx(285.0)
    assert melody_score(summary(0, "Strings", 400, 60.0, 0.9)) == pytest.approx(40.0)
    # Below the singing range (mean pitch under 55) the score drops to a fifth.
    assert melody_score(summary(2, "Bass", 300, 40.0, 0.0)) == pytest.approx(60.0)


def test_drums_never_carry_the_melody_and_ties_keep_track_order():
    tracks = [
        summary(0, "Strings", 400, 60.0, 0.9),
        summary(1, "Voz", 200, 67.0, 0.05),
        summary(2, "Bass", 300, 40.0, 0.0),
        summary(3, "Drums", 900, 40.0, 0.0, is_drum=True),
        summary(4, "Copy of strings", 400, 60.0, 0.9),
    ]
    assert rank_melody_tracks(tracks) == [1, 2, 0, 4]
    assert rank_melody_tracks([tracks[3]]) == []


@pytest.mark.parametrize("song", ranking_songs(), ids=lambda song: Path(song["path"]).stem)
def test_the_ranking_port_gives_the_apps_ranking_on_the_project_midi_songs(song):
    path = REPO / song["path"]
    if not path.exists() or file_sha256(path) != song["sha256"]:
        pytest.skip(f"{song['path']} is not here; run uv run src/main.py fetch")
    tracks = describe_tracks(pretty_midi.PrettyMIDI(str(path)))

    assert [track.index for track in tracks] == [track["index"] for track in song["tracks"]]
    for track, expected in zip(tracks, song["tracks"], strict=True):
        assert (track.name, track.program, track.is_drum, track.note_count) == (
            expected["name"],
            expected["program"],
            expected["is_drum"],
            expected["note_count"],
        )
        if expected["mean_pitch"] is not None:
            assert track.mean_pitch == pytest.approx(expected["mean_pitch"], abs=1e-9)
        assert track.polyphony == pytest.approx(expected["polyphony"], abs=1e-9)
    assert rank_melody_tracks(tracks) == song["ranking"]


# --- Key estimate and sprite seed ---


def test_the_key_estimate_finds_the_tonic_and_the_mode_of_a_pitch_class_profile():
    c_major = [3.0, 0, 1.0, 0, 2.0, 1.0, 0, 2.5, 0, 1.0, 0, 1.0]
    a_minor = [1.0, 0, 1.0, 0, 2.0, 1.0, 0, 0.5, 0, 3.0, 0, 1.0]
    assert estimate_key(c_major) == "C major"
    assert estimate_key(a_minor) == "a minor"
    assert estimate_key([0.0] * 12) == ""


def test_the_sprite_seed_is_the_first_32_bits_of_the_sha256_of_source_and_id():
    import hashlib

    digest = hashlib.sha256(b"mpb:aquarela").digest()
    assert sprite_seed("mpb", "aquarela") == int.from_bytes(digest[:4], "big")
    assert 0 <= sprite_seed("examples", "korobeiniki") < 2**32
    assert sprite_seed("mpb", "a") != sprite_seed("pdmx", "a")


# --- analyze_midi ---


def write_long_song(path: Path, bars: int, lead_in_bars: int = 0) -> Path:
    """A 4/4 song at 120 BPM: drums from bar 0, melody and bass from `lead_in_bars` on."""
    midi = pretty_midi.PrettyMIDI(initial_tempo=120.0)
    beat = 0.5
    voice = pretty_midi.Instrument(program=73, name="voz")
    bass = pretty_midi.Instrument(program=33, name="bass")
    drums = pretty_midi.Instrument(program=0, is_drum=True, name="drums")
    for bar in range(bars):
        start = bar * 4 * beat
        drums.notes.append(pretty_midi.Note(90, 36, start, start + 0.1))
        if bar < lead_in_bars:
            continue
        for step, pitch in enumerate((72, 76, 79, 76)):
            voice.notes.append(
                pretty_midi.Note(90, pitch, start + step * beat, start + (step + 1) * beat)
            )
        bass.notes.append(pretty_midi.Note(80, 36, start, start + 4 * beat))
    midi.instruments += [bass, voice, drums]
    midi.write(str(path))
    return path


def test_analyze_midi_records_every_fact_of_the_data_model_and_no_notes():
    path = SYNTHETIC / "synthetic-count-in.mid"
    facts = analyze_midi(path, "https://example.org/song.mid")

    assert set(facts) == FACT_FIELDS
    assert facts["midi"] == "https://example.org/song.mid"
    assert facts["sha256"] == file_sha256(path)
    assert facts["melody_track"] == 0
    assert facts["sections"] == [[0, "A"]]
    assert (
        facts["overrides"]
        == MIDI_SONG_OVERRIDES
        == {
            "max_generations": 4000,
            "stagnation_window": 400,
        }
    )
    assert facts["drums"] is True
    first, end = facts["bars"]
    assert facts["n_bars"] == end - first
    assert first == 2  # bars 0 and 1 are a drum-only count-in in 3/4
    assert facts["meter"] == "4/4"
    assert isinstance(facts["key"], str) and isinstance(facts["meter"], str)
    # Facts are a few scalars: nothing in them can hold a melody.
    for value in facts.values():
        assert not (isinstance(value, list) and len(value) > 2)


def test_the_bar_range_starts_at_the_first_noted_bar_and_is_capped_at_64_bars(tmp_path):
    facts = analyze_midi(write_long_song(tmp_path / "long.mid", bars=100, lead_in_bars=3))

    assert MAX_EXCERPT_BARS == 64
    assert facts["bars"] == [3, 3 + 64]
    assert facts["n_bars"] == 64
    assert facts["melody_track"] == 1  # the voice, not the bass
    assert facts["meter"] == "4/4"
    assert facts["tempo_bpm"] == pytest.approx(120.0)
    assert facts["key"] == "C major"
    assert facts["midi"] == (tmp_path / "long.mid").as_posix()


def test_a_short_song_keeps_all_its_noted_bars(tmp_path):
    facts = analyze_midi(write_long_song(tmp_path / "short.mid", bars=12))
    assert facts["bars"] == [0, 12]


def test_a_file_the_reader_refuses_gets_a_short_error_and_no_reduction_facts(tmp_path):
    drums_only = pretty_midi.PrettyMIDI(initial_tempo=120.0)
    kit = pretty_midi.Instrument(program=0, is_drum=True)
    kit.notes.append(pretty_midi.Note(90, 36, 0.0, 0.1))
    drums_only.instruments.append(kit)
    drums_only.write(str(tmp_path / "drums.mid"))
    (tmp_path / "broken.mid").write_bytes(b"MThd\x00\x00\x00\x06\x00\x01")

    for name in ("drums.mid", "broken.mid"):
        facts = analyze_midi(tmp_path / name)
        assert set(facts) == {"midi", "sha256", "error"}
        assert 0 < len(facts["error"]) <= 120


def test_the_recorded_facts_reduce_the_file_to_the_same_lead_sheet_as_the_analysis(tmp_path):
    from catalog.analysis import analyze_and_reduce, reduce_with_facts

    path = write_long_song(tmp_path / "song.mid", bars=80, lead_in_bars=2)
    facts, analyzed = analyze_and_reduce(path)
    served = reduce_with_facts(path, facts)

    assert served.bars == analyzed.bars
    assert served.tempo_bpm == analyzed.tempo_bpm
    assert reduce_with_facts(path, facts, title="Song").title == "Song"


def test_a_file_that_changed_since_the_analysis_is_refused(tmp_path):
    from catalog.analysis import reduce_with_facts

    path = write_long_song(tmp_path / "song.mid", bars=8)
    facts = analyze_midi(path)
    write_long_song(path, bars=9)
    with pytest.raises(ValueError, match="sha256"):
        reduce_with_facts(path, facts)


def brute_force_overlap_share(notes) -> float:
    """The app's algorithm, pair by pair: a note overlaps when another note sounds with it."""
    ordered = sorted(notes, key=lambda note: note.start)
    flags = [False] * len(ordered)
    for i, first in enumerate(ordered):
        for j in range(i + 1, len(ordered)):
            later = ordered[j]
            if later.start < first.end and later.end > first.start:
                flags[i] = flags[j] = True
    return sum(flags) / len(ordered) if ordered else 0.0


def test_the_polyphony_share_matches_the_pairwise_definition_on_tricky_notes():
    import numpy as np

    from catalog.analysis import overlap_share

    rng = np.random.default_rng(7)
    for _ in range(200):
        count = int(rng.integers(0, 12))
        starts = rng.integers(0, 8, count) / 2
        lengths = rng.integers(0, 4, count) / 2  # zero-length notes included
        notes = [
            pretty_midi.Note(90, 60, float(start), float(start + length))
            for start, length in zip(starts, lengths, strict=True)
        ]
        assert overlap_share(notes) == brute_force_overlap_share(notes)


def test_the_polyphony_share_is_fast_on_long_sustained_tracks():
    import time

    from catalog.analysis import overlap_share

    # Every note held to the end, as in a file that lost its note-offs: all pairs overlap.
    notes = [pretty_midi.Note(90, 60, step * 0.1, 2000.0) for step in range(20000)]
    began = time.perf_counter()
    assert overlap_share(notes) == 1.0
    assert time.perf_counter() - began < 1.0


def test_bars_that_start_off_the_sixteenth_grid_are_refused_before_reading(tmp_path):
    # A time signature 10 ticks after the start (of 384 per beat) moves every bar line off the
    # sixteenth-note grid: the lead sheet could not be written, and the reader could loop.
    path = write_long_song(tmp_path / "late-meter.mid", bars=40, lead_in_bars=2)
    midi = pretty_midi.PrettyMIDI(str(path))
    midi.time_signature_changes = [pretty_midi.TimeSignature(4, 4, midi.tick_to_time(10))]
    midi.write(str(path))

    facts = analyze_midi(path)
    assert "sixteenth-note grid" in facts["error"]


def test_a_runaway_reduction_gives_a_reason_instead_of_stopping_the_batch(monkeypatch):
    import time

    from catalog import analysis

    def swells(job):
        raise MemoryError

    def loops(job):
        time.sleep(5)

    monkeypatch.setattr(analysis, "FILE_SECONDS", 1)
    assert analysis.guarded(swells, None, str) == "the reduction ran out of memory"
    assert analysis.guarded(loops, None, str) == "the reduction took over 1 s"
    assert analysis.guarded(lambda job: job + 1, 1, str) == 2


def test_a_lead_sheet_the_abc_reader_cannot_read_back_gets_no_route(tmp_path, monkeypatch):
    from catalog import analysis

    def refuses(text, phrase_length=4):
        raise ValueError("music21 found 9 bars but the bar lines of the text close 8; check")

    monkeypatch.setattr(analysis, "read_lead_sheet_text", refuses)
    facts = analyze_midi(write_long_song(tmp_path / "song.mid", bars=8))
    assert facts["error"] == (
        "the lead sheet does not read back: "
        "music21 found 9 bars but the bar lines of the text close 8"
    )
