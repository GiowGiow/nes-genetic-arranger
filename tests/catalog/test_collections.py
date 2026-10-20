"""Redistributable lead sheets: folk ABC through the MIDI reduction, and the collection writers.

Folk collections write tunes with repeat signs, pickups and chord symbols, which the lead-sheet
ABC reader refuses by design. `abc_tune_to_midi` turns such a tune into a small MIDI song (repeats
written out, the pickup padded to a full bar, chord symbols played by an accompaniment), and
`reduce_tune` reduces it like any MIDI song (research R10). The writers then commit only what may
be redistributed: public-domain MPB songs, the Nottingham collection (GPL-3.0) and a PDMX subset,
each with provenance headers and the collection's license (research R11, R12).

Every tune here is synthetic, written for these tests.
"""

import argparse
import csv
import io
import json
import shutil
import tarfile
from pathlib import Path

import pytest

from catalog.analysis import write_mpb_catalog
from catalog.authors import AuthorRecord, read_authors, read_card_composers, write_authors
from catalog.cards import sprite_seed
from catalog.collections import (
    PDMX_COLUMNS,
    abc_tune_to_midi,
    mark_repeat_starts,
    normalize_chord_symbol,
    pdmx_author_names,
    reduce_tune,
    select_pdmx_rows,
    split_tunes,
    write_nottingham,
    write_pdmx,
    write_public_domain,
)
from catalog.crawl import add_catalog_parser
from leadsheet.abc_reader import read_lead_sheet_text
from leadsheet.abc_writer import lead_sheet_to_abc

REPO = Path(__file__).resolve().parents[2]
SYNTHETIC = REPO / "arranger/tests/fixtures/midi-songs"

# A reel with a pickup, a repeat with first and second endings, and chord symbols.
REEL = """X:7
T:Synthetic Reel
M:4/4
L:1/8
K:G
D2 |: "G"G2B2 d2B2 | "C"c2e2 "D7"d2c2 |1 "G"B2G2 G2D2 :|2 "G"B2A2 G4 |]
"""


def melody_pitches(sheet, bar):
    return [note.pitch for note in sheet.bars[bar].melody]


# --- abc_tune_to_midi and reduce_tune (T022) ---


def test_repeats_and_endings_are_written_out():
    midi = abc_tune_to_midi(REEL)
    melody = midi.instruments[0]
    # Pickup 1 + bars 1, 2, ending 1 (4 + 4 + 4), then bars 1, 2 again and ending 2 (4 + 4 + 3).
    assert len(melody.notes) == 1 + 12 + 11
    pitches = [note.pitch for note in sorted(melody.notes, key=lambda n: n.start)]
    assert pitches[13:17] == [67, 71, 74, 71]  # the repeat starts over at bar 1


def test_a_pickup_is_padded_to_a_full_bar_with_a_leading_rest():
    midi = abc_tune_to_midi(REEL)
    first = min(midi.instruments[0].notes, key=lambda n: n.start)
    beat = 60.0 / midi.get_tempo_changes()[1][0]
    assert first.pitch == 62
    assert first.start == pytest.approx(3 * beat)  # the D quarter note is the bar's last beat
    signatures = [(ts.numerator, ts.denominator, ts.time) for ts in midi.time_signature_changes]
    assert signatures == [(4, 4, 0.0)]


def test_chord_symbols_become_an_accompaniment_and_a_bass_track():
    midi = abc_tune_to_midi(REEL)
    names = [instrument.name for instrument in midi.instruments]
    assert names == ["melody", "chords", "bass"]
    beat = 60.0 / midi.get_tempo_changes()[1][0]
    chords = midi.instruments[1]
    # The C chord of bar 2 sounds C, E and G from beat 8 (bar 2 starts after the padded pickup).
    at_c = {note.pitch % 12 for note in chords.notes if note.start == pytest.approx(8 * beat)}
    assert at_c == {0, 4, 7}
    bass = midi.instruments[2]
    assert all(note.pitch < 50 for note in bass.notes)


def test_the_reduced_tune_has_the_bars_melody_and_chords_of_the_written_out_tune():
    sheet = reduce_tune(REEL)

    assert sheet.title == "Synthetic Reel"
    assert sheet.key == "G major"
    assert sheet.tempo_bpm == 140.0  # the project's default tempo, exactly
    assert len(sheet.bars) == 7
    assert [(n.pitch, n.onset, n.duration) for n in sheet.bars[0].melody] == [(62, 3.0, 1.0)]
    assert melody_pitches(sheet, 3) == [71, 67, 67, 62]  # first ending
    assert melody_pitches(sheet, 6) == [71, 69, 67]  # second ending
    assert [chord.symbol for chord in sheet.bars[2].chords] == ["C", "D7"]
    assert [chord.symbol for chord in sheet.bars[1].chords] == ["G"]


def test_the_reduced_lead_sheet_reads_back_with_the_abc_reader():
    sheet = reduce_tune(REEL)
    again = read_lead_sheet_text(lead_sheet_to_abc(sheet, 4), phrase_length=4)

    assert [bar.melody for bar in again.bars] == [bar.melody for bar in sheet.bars]
    assert [[c.symbol for c in bar.chords] for bar in again.bars] == [
        [c.symbol for c in bar.chords] for bar in sheet.bars
    ]
    assert again.key == "G major"


def test_a_repeat_after_a_double_bar_goes_back_to_that_bar_not_to_the_start():
    tune = 'X:1\nT:Parts\nM:4/4\nL:1/4\nK:C\nP:A\n"C"CDEF|GABc:|\nP:B\n"G"defg|abc\'d\':|\n'
    sheet = reduce_tune(tune)
    firsts = [bar.melody[0].pitch for bar in sheet.bars]
    assert firsts == [60, 67, 60, 67, 74, 81, 74, 81]  # A A B B, not A A B A B


def test_repeat_starts_are_marked_where_music21_would_go_back_too_far():
    assert mark_repeat_starts(['"C"CDEF|GABc:||defg|abcd:|']) == ['"C"CDEF|GABc:||:defg|abcd:|']
    assert mark_repeat_starts(["P:B", "defg|abcd:|"]) == ["P:B", "|:defg|abcd:|"]
    assert mark_repeat_starts(["CDEF|[1GABc:|[2cBAG||defg|abcd:|"]) == [
        "CDEF|[1GABc:|[2cBAG|| |:defg|abcd:|"
    ]
    already = ["|:CDEF|GABc:|", "|:defg|abcd:|"]
    assert mark_repeat_starts(already) == already


def test_folk_chord_spellings_are_turned_into_symbols_music21_reads():
    assert normalize_chord_symbol("Gd") == "Gdim"
    assert normalize_chord_symbol("Ca") == "Caug"
    assert normalize_chord_symbol("D/f+") == "D/F#"
    assert normalize_chord_symbol("Gm/bb") == "Gm/Bb"
    assert normalize_chord_symbol("(E7)") == "E7"
    assert normalize_chord_symbol("Am7") == "Am7"


def test_a_tune_without_notes_is_refused_with_a_reason():
    with pytest.raises(ValueError, match="no notes"):
        reduce_tune('X:1\nT:Rests\nM:4/4\nL:1/4\nK:C\n"C"z4|"G"z4|\n')


def test_a_collection_file_splits_into_tunes_by_x_number():
    text = "% header\n\nX: 1\nT:One\nK:C\nCDEF|\n\n\nX:2\nT:Two\nK:G\nGABc|\n"
    assert [(number, tune.splitlines()[1]) for number, tune in split_tunes(text)] == [
        (1, "T:One"),
        (2, "T:Two"),
    ]


# --- Writers (T033) ---

COLUMNS = [
    "id",
    "title",
    "composers",
    "performer",
    "themes",
    "letter",
    "variant",
    "variants",
    "path",
    "page_url",
    "midi_url",
    "bytes",
    "sha256",
    "midi_type",
    "ticks_per_beat",
    "tracks",
    "duration_s",
    "notes",
    "channels",
    "programs",
    "has_drums",
    "tempo_bpm",
    "time_signature",
    "key",
    "lyric_events",
    "track_names",
    "error",
]


def mpb_dataset(folder: Path) -> Path:
    songs = [
        ("valsa", "VALSA ANTIGA", "Ernesto Nazareth", "synthetic-waltz.mid"),
        ("choro", "CHORO NOVO", "Ernesto Nazareth e Caetano Veloso", "synthetic-changes.mid"),
        ("modinha", "MODINHA", "Fulano Desconhecido", "synthetic-count-in.mid"),
    ]
    rows = []
    for song_id, title, composers, fixture in songs:
        path = f"midi/mpb_{song_id[0]}/{song_id}.mid"
        (folder / path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(SYNTHETIC / fixture, folder / path)
        row = dict.fromkeys(COLUMNS, "")
        row |= {
            "id": song_id,
            "title": title,
            "composers": composers,
            "performer": "Banda",
            "variant": "1",
            "variants": "1",
            "path": path,
            "page_url": f"https://www.beakauffmann.com/mpb_{song_id[0]}/{song_id}.html",
            "midi_url": f"https://www.beakauffmann.com/mpb_{song_id[0]}/som/{song_id}.mid",
        }
        rows.append(row)
    with (folder / "metadata.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    return folder


def authors_file(path: Path) -> Path:
    page = "https://www.wikidata.org/wiki/"
    return write_authors(
        [
            AuthorRecord(
                "Ernesto Nazareth", "Q982541", 1934, "dead", page + "Q982541", "2026-10-20"
            ),
            AuthorRecord(
                "Caetano Veloso", "Q309941", None, "alive", page + "Q309941", "2026-10-20"
            ),
        ],
        path,
    )


def test_public_domain_mpb_songs_are_written_with_authors_and_provenance(tmp_path):
    dataset = mpb_dataset(tmp_path / "dataset")
    out_dir, catalog = tmp_path / "abc", tmp_path / "public-domain.json"

    entries, skipped = write_public_domain(
        dataset, authors_file(tmp_path / "authors.json"), out_dir, catalog
    )

    assert skipped == {}
    # The other songs have a living or an unknown author.
    assert [entry["id"] for entry in entries] == ["valsa"]
    abc = (out_dir / "valsa.abc").read_text(encoding="utf-8")
    header = [line for line in abc.splitlines() if line.startswith("%")]
    text = " ".join(header)
    for expected in (
        "Ernesto Nazareth",
        "1934",
        "Q982541",
        "https://www.beakauffmann.com/mpb_v/som/valsa.mid",
        "public domain",
        "uv run src/main.py catalog public-domain",
    ):
        assert expected in text
    assert any("sha256" in line for line in header)
    read_lead_sheet_text(abc)  # the committed lead sheet reads back
    record = json.loads(catalog.read_text(encoding="utf-8"))
    assert record["source"] == "public-domain"
    entry = record["entries"][0]
    assert entry["route"] == {"abc": "data/catalog/abc/public-domain/valsa.abc", "tune": 0}
    assert entry["license"] == "public-domain"
    assert entry["seed"] == sprite_seed("public-domain", "valsa")
    assert entry["facts"]["meter"] == "3/4"
    assert entry["facts"]["midi"] == "https://www.beakauffmann.com/mpb_v/som/valsa.mid"
    assert entry["facts"]["overrides"] == {"max_generations": 4000, "stagnation_window": 400}


def test_public_domain_songs_leave_the_mpb_card_so_no_song_is_listed_twice(tmp_path):
    dataset = mpb_dataset(tmp_path / "dataset")
    authors = authors_file(tmp_path / "authors.json")
    entries = write_mpb_catalog(dataset, tmp_path / "mpb.json", authors=read_authors(authors))
    public, _ = write_public_domain(dataset, authors, tmp_path / "abc", tmp_path / "pd.json")

    assert [entry["id"] for entry in entries] == ["choro", "modinha"]
    assert [entry["id"] for entry in public] == ["valsa"]
    assert sorted(set(read_card_composers(tmp_path / "mpb.json", tmp_path / "pd.json"))) == [
        "Caetano Veloso",
        "Ernesto Nazareth",
        "Fulano Desconhecido",
    ]


def nottingham_source(folder: Path) -> Path:
    (folder / "ABC_cleaned").mkdir(parents=True)
    (folder / "LICENSE.md").write_text("GNU GENERAL PUBLIC LICENSE\nVersion 3\n")
    (folder / "ABC_cleaned/reels.abc").write_text(
        REEL.replace("X:7", "X: 1")
        + "\n\n"
        + REEL.replace("X:7", "X: 2").replace("Reel", "Reel Two")
    )
    (folder / "ABC_cleaned/rests.abc").write_text(
        'X: 1\nT:Rests\nM:4/4\nL:1/4\nK:C\n"C"z4|"G"z4|\n'
    )
    return folder


def test_nottingham_tunes_are_written_one_per_file_with_the_license(tmp_path, capsys):
    out_dir, catalog = tmp_path / "abc", tmp_path / "nottingham.json"
    entries, skipped = write_nottingham(nottingham_source(tmp_path / "src"), out_dir, catalog)

    assert sorted(path.name for path in out_dir.iterdir()) == [
        "LICENSE.md",
        "reels-1.abc",
        "reels-2.abc",
    ]
    assert skipped == {"the tune has no notes": 1}
    header = (out_dir / "reels-2.abc").read_text(encoding="utf-8").split("X:1")[0]
    assert "GPL-3.0" in header and "ABC_cleaned/reels.abc" in header and "X: 2" in header
    assert "uv run src/main.py catalog nottingham" in header
    record = json.loads(catalog.read_text(encoding="utf-8"))
    assert [entry["id"] for entry in record["entries"]] == ["reels-1", "reels-2"]
    assert record["entries"][1]["route"] == {
        "abc": "data/catalog/abc/nottingham/reels-2.abc",
        "tune": 0,
    }
    assert record["entries"][1]["license"] == "GPL-3.0"
    assert "GPL-3.0" in record["license"]


def test_the_nottingham_writer_rewrites_the_same_bytes(tmp_path):
    source = nottingham_source(tmp_path / "src")
    write_nottingham(source, tmp_path / "a", tmp_path / "a.json")
    write_nottingham(source, tmp_path / "b", tmp_path / "b.json", workers=2)
    assert (tmp_path / "a/reels-1.abc").read_bytes() == (tmp_path / "b/reels-1.abc").read_bytes()
    assert (tmp_path / "a.json").read_bytes() == (tmp_path / "b.json").read_bytes()


# --- PDMX (research R12) ---


def pdmx_row(name, **fields):
    row = dict.fromkeys(PDMX_COLUMNS, "")
    row |= {
        "path": f"./data/1/11/{name}.json",
        "mid": f"./mid/1/11/{name}.mid",
        "is_original": "False",
        "n_ratings": "1",
        "rating": "4.0",
        "license": "publicdomain",
        "song_name": name,
        "composer_name": "Ernesto Nazareth",
        "artist_name": "uploader",
        "song_length.bars": "32",
        "is_best_unique_arrangement": "True",
        "subset:no_license_conflict": "True",
    }
    return row | {key: str(value) for key, value in fields.items()}


def pdmx_csv(path: Path, rows: list[dict]) -> Path:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, PDMX_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    return path


PDMX_ROWS = [
    pdmx_row("QmFree", rating="4.5", n_ratings="10"),
    pdmx_row("QmBetter", rating="4.9", n_ratings="2", license="cc-zero"),
    pdmx_row("QmConflict", **{"subset:no_license_conflict": "False"}),
    pdmx_row("QmDuplicate", is_best_unique_arrangement="False"),
    pdmx_row("QmShort", **{"song_length.bars": "4"}),
    pdmx_row("QmLong", **{"song_length.bars": "300"}),
    pdmx_row("QmLiving", composer_name="Caetano Veloso"),
    pdmx_row("QmUnknown", composer_name="Someone Else"),
    pdmx_row("QmNoComposer", composer_name=""),
    pdmx_row("QmOriginal", composer_name="", is_original="True"),
    pdmx_row("QmMissing", composer_name="NA"),  # PDMX writes a missing composer as NA
    pdmx_row("QmNoMidi", mid="NA"),  # a score without a MIDI file cannot be reduced
]


def test_the_pdmx_filter_keeps_free_unique_unconflicted_tunes_ranked_by_rating(tmp_path):
    authors = {
        "Ernesto Nazareth": AuthorRecord("Ernesto Nazareth", "Q1", 1934, "dead", "", ""),
        "Caetano Veloso": AuthorRecord("Caetano Veloso", "Q2", None, "alive", "", ""),
    }
    path = pdmx_csv(tmp_path / "PDMX.csv", PDMX_ROWS)

    kept = select_pdmx_rows(path, authors, limit=10)
    assert [row["song_name"] for row in kept] == ["QmBetter", "QmFree"]
    assert [row["song_name"] for row in select_pdmx_rows(path, authors, limit=1)] == ["QmBetter"]


def test_the_pdmx_author_walk_resolves_only_the_names_of_candidate_tunes(tmp_path):
    path = pdmx_csv(tmp_path / "PDMX.csv", PDMX_ROWS)
    asked = []

    def resolve(names):
        names = list(names)
        asked.extend(names)
        return [AuthorRecord(name, None, None, "unknown", "", "") for name in names]

    records = pdmx_author_names(path, 5, resolve)
    assert sorted({record.name for record in records}) == [
        "Caetano Veloso",
        "Ernesto Nazareth",
        "Someone Else",
    ]
    assert "NA" not in asked


def midi_bytes(fixture: str) -> bytes:
    return (SYNTHETIC / fixture).read_bytes()


def test_pdmx_tunes_are_reduced_from_the_archive_with_a_notice(tmp_path):
    source = tmp_path / "pdmx"
    source.mkdir()
    pdmx_csv(source / "PDMX.csv", PDMX_ROWS)
    with tarfile.open(source / "mid.tar.gz", "w:gz") as archive:
        for name, fixture in (
            ("QmFree", "synthetic-waltz.mid"),
            ("QmBetter", "synthetic-changes.mid"),
        ):
            data = midi_bytes(fixture)
            info = tarfile.TarInfo(f"mid/1/11/{name}.mid")
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    authors = authors_file(tmp_path / "authors.json")
    out_dir, catalog = tmp_path / "abc", tmp_path / "pdmx.json"

    entries, skipped = write_pdmx(source, authors, out_dir, catalog, limit=10)

    assert skipped == {}
    assert sorted(path.name for path in out_dir.iterdir()) == [
        "NOTICE.md",
        "QmBetter.abc",
        "QmFree.abc",
    ]
    notice = (out_dir / "NOTICE.md").read_text(encoding="utf-8")
    assert "CC BY 4.0" in notice and "10.5281/zenodo.15571083" in notice
    header = (out_dir / "QmFree.abc").read_text(encoding="utf-8")
    assert "Ernesto Nazareth" in header and "PDMX" in header and "sha256" in header
    record = json.loads(catalog.read_text(encoding="utf-8"))
    by_id = {entry["id"]: entry for entry in record["entries"]}
    assert by_id["QmBetter"]["license"] == "CC0"
    assert by_id["QmFree"]["license"] == "PDM"
    assert by_id["QmFree"]["route"] == {"abc": "data/catalog/abc/pdmx/QmFree.abc", "tune": 0}
    assert by_id["QmFree"]["facts"]["midi"] == "mid/1/11/QmFree.mid"


def test_the_collection_commands_are_registered():
    parser = argparse.ArgumentParser()
    add_catalog_parser(parser.add_subparsers(dest="command", required=True))
    for command in ("public-domain", "nottingham", "pdmx", "examples"):
        extra = ["--dataset", "x"] if command == "public-domain" else []
        args = parser.parse_args(["catalog", command, *extra])
        assert callable(args.handler)
    assert parser.parse_args(["catalog", "pdmx"]).limit == 2000


def test_the_examples_catalog_lists_the_eight_examples_with_abc_routes(tmp_path):
    from catalog.collections import write_examples

    out = tmp_path / "examples.json"
    entries = write_examples(REPO / "data/sources.json", out)
    record = json.loads(out.read_text(encoding="utf-8"))

    assert len(entries) == 8
    by_id = {entry["id"]: entry for entry in record["entries"]}
    assert by_id["korobeiniki"]["route"] == {"abc": "data/leadsheets/korobeiniki.abc", "tune": 0}
    assert by_id["korobeiniki"]["t"] == "Korobeiniki (Tetris theme)"
    assert by_id["korobeiniki"]["facts"] == {
        "key": "a minor",
        "tempo_bpm": 150.0,
        "meter": "4/4",
        "n_bars": len(
            read_lead_sheet_text((REPO / "data/leadsheets/korobeiniki.abc").read_text()).bars
        ),
    }
    assert by_id["mulher_de_fases"]["route"] == {
        "abc": "data/leadsheets/mulher_de_fases.abc",
        "tune": 0,
    }
    assert by_id["mulher_de_fases"]["facts"]["overrides"] == {
        "max_generations": 4000,
        "stagnation_window": 400,
    }
    assert "overrides" not in by_id["korobeiniki"]["facts"]
    # The card keeps the order of arranger/src/ui/examples.js: traditional tunes, then the manifest.
    manifest = [
        song["id"] for song in json.loads((REPO / "data/sources.json").read_text())["songs"]
    ]
    order = sorted(record["entries"], key=lambda entry: entry["order"])
    assert [entry["id"] for entry in order] == ["korobeiniki", "ievan_polkka", *manifest]
    assert by_id["mulher_de_fases"]["c"] == "Digão, Rodolfo"
    assert by_id["mulher_de_fases"]["p"] == "Raimundos"
    assert by_id["mulher_de_fases"]["seed"] == sprite_seed("examples", "mulher_de_fases")
    assert record["source"] == "examples"


def test_a_repeat_that_replays_the_pickup_keeps_the_bar_lines_in_place():
    # The repeat goes back to the tune start, so the pickup A completes the short last bar.
    jig = 'X:1\nT:Jig\nM:6/8\nL:1/8\nK:D\nA|"D"d2d f2d|"A"e2e c2A|"D"d2d f2d|"A"e2c d2:|\n'
    sheet = reduce_tune(jig)

    assert len(sheet.bars) == 9
    assert all(str(bar.meter) == "6/8" for bar in sheet.bars)
    assert melody_pitches(sheet, 4) == [76, 73, 74, 69]


def test_a_double_bar_inside_an_open_repeat_does_not_move_its_start():
    body = ['"C"CDEF|GABc:: "G"defg||abcd:|']
    assert mark_repeat_starts(body) == body


def test_an_end_and_start_repeat_sign_keeps_both_repeats():
    tune = 'X:1\nT:Two\nM:4/4\nL:1/4\nK:C\n|:"C"CDEF|GABc:|:"G"defg|abcd:|\n'
    firsts = [bar.melody[0].pitch for bar in reduce_tune(tune).bars]
    assert firsts == [60, 67, 60, 67, 74, 81, 74, 81]


def test_a_tune_without_chord_symbols_takes_its_chords_from_the_melody():
    tune = "X:1\nT:Bare\nM:4/4\nL:1/4\nK:G\nGBdB|GBdB|ADFA|ADFA|\n"
    midi = abc_tune_to_midi(tune)
    sheet = reduce_tune(tune)

    assert len(midi.instruments[1].notes) == len(midi.instruments[0].notes)
    assert [bar.chords[0].symbol for bar in sheet.bars] == ["G", "G", "D", "D"]
