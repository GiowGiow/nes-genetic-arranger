"""The MPB catalog file: metadata, links and analysis facts, never notes.

`catalog analyze --dataset <dir>` reads the local study copy of the MPB MIDI files and writes
`arranger/data/catalog/mpb.json` (contracts/catalog-files.md). These tests build a tiny dataset
from the project's synthetic MIDI songs and a `metadata.csv` with the study copy's columns.
"""

import argparse
import csv
import json
import shutil
from pathlib import Path

from catalog.analysis import read_dataset, write_mpb_catalog
from catalog.cards import sprite_seed
from catalog.crawl import add_catalog_parser

REPO = Path(__file__).resolve().parents[2]
SYNTHETIC = REPO / "arranger/tests/fixtures/midi-songs"
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
SITE = "https://www.beakauffmann.com/"
ENVELOPE = ["source", "name", "home", "license", "credit", "note", "generated", "entries"]


def make_dataset(folder: Path) -> Path:
    """Five rows: a waltz, a song with two MIDI files, a broken file and a missing link."""
    songs = [
        ("valsa", "VALSA", "Fulano e Beltrano", "Banda", "synthetic-waltz.mid", 1, 1, ""),
        ("zabumba-1#1", "ZABUMBA", "Ciclano", "Grupo", "synthetic-changes.mid", 1, 2, ""),
        ("zabumba-2#2", "ZABUMBA", "Ciclano", "Grupo", "synthetic-count-in.mid", 2, 2, ""),
        ("abacaxi", "ÁBACO", "Ninguém", "Solo", None, 1, 1, ""),
        ("perdida", "PERDIDA", "Alguém", "Banda", None, 1, 1, "missing"),
    ]
    rows = []
    for song_id, title, composers, performer, fixture, variant, variants, error in songs:
        slug = song_id.split("#")[0]
        path = f"midi/mpb_{slug[0]}/{slug}.mid"
        if fixture is not None:
            (folder / path).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(SYNTHETIC / fixture, folder / path)
        elif error != "missing":
            (folder / path).parent.mkdir(parents=True, exist_ok=True)
            (folder / path).write_bytes(b"MThd\x00\x00\x00\x06")  # truncated header
        row = dict.fromkeys(COLUMNS, "")
        row |= {
            "id": song_id,
            "title": title,
            "composers": composers,
            "performer": performer,
            "letter": slug[0],
            "variant": str(variant),
            "variants": str(variants),
            "path": path,
            "page_url": f"{SITE}mpb_{slug[0]}/{slug.rsplit('-', 1)[0]}.html",
            "midi_url": f"{SITE}mpb_{slug[0]}/som/{slug}.mid",
            "error": error,
        }
        rows.append(row)
    with (folder / "metadata.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    return folder


def test_the_dataset_rows_use_the_file_name_as_a_unique_id(tmp_path):
    rows = read_dataset(make_dataset(tmp_path))
    assert [row.song_id for row in rows] == [
        "valsa",
        "zabumba-1",
        "zabumba-2",
        "abacaxi",
        "perdida",
    ]
    assert [row.missing for row in rows] == [False, False, False, False, True]


def test_the_catalog_has_the_envelope_and_entry_fields_of_the_contract(tmp_path):
    out = tmp_path / "mpb.json"
    write_mpb_catalog(make_dataset(tmp_path / "dataset"), out)
    record = json.loads(out.read_text(encoding="utf-8"))

    assert list(record) == ENVELOPE
    assert record["source"] == "mpb"
    assert record["home"] == SITE
    assert "Beatriz Kauffmann" in record["credit"]
    assert record["generated"].startswith("uv run src/main.py catalog analyze --dataset")
    entries = {entry["id"]: entry for entry in record["entries"]}
    valsa = entries["valsa"]
    assert valsa["source"] == "mpb"
    assert (valsa["t"], valsa["c"], valsa["p"]) == ("VALSA", "Fulano e Beltrano", "Banda")
    assert valsa["u"] == f"{SITE}mpb_v/valsa.html"
    assert valsa["license"] == "all-rights-reserved"
    assert valsa["seed"] == sprite_seed("mpb", "valsa")
    assert valsa["route"] == {"download": f"{SITE}mpb_v/som/valsa.mid"}
    assert valsa["facts"]["midi"] == f"{SITE}mpb_v/som/valsa.mid"
    assert valsa["facts"]["meter"] == "3/4"
    assert "variant" not in valsa


def test_every_entry_has_a_download_route_or_an_error_and_variants_are_labeled(tmp_path):
    out = tmp_path / "mpb.json"
    entries = write_mpb_catalog(make_dataset(tmp_path / "dataset"), out)
    by_id = {entry["id"]: entry for entry in entries}

    for entry in entries:
        assert ("route" in entry) != ("error" in entry)
    assert [by_id["zabumba-1"]["variant"], by_id["zabumba-2"]["variant"]] == ["1/2", "2/2"]
    assert "route" in by_id["zabumba-1"] and "route" in by_id["zabumba-2"]
    assert by_id["abacaxi"]["error"].startswith("unreadable MIDI file")
    assert by_id["perdida"]["error"] == "the MIDI link is broken at the catalog site"
    assert by_id["perdida"]["facts"] == {"midi": f"{SITE}mpb_p/som/perdida.mid"}


def test_the_catalog_is_sorted_by_title_and_rewritten_byte_for_byte(tmp_path):
    dataset = make_dataset(tmp_path / "dataset")
    first, second = tmp_path / "first.json", tmp_path / "second.json"
    write_mpb_catalog(dataset, first)
    write_mpb_catalog(dataset, second, workers=2)

    assert first.read_bytes() == second.read_bytes()
    titles = [entry["t"] for entry in json.loads(first.read_text(encoding="utf-8"))["entries"]]
    assert titles == ["ÁBACO", "PERDIDA", "VALSA", "ZABUMBA", "ZABUMBA"]
    lines = first.read_text(encoding="utf-8").splitlines()
    assert sum(line.startswith('    {"id":') for line in lines) == 5  # one entry per line


def test_no_note_data_appears_in_the_catalog(tmp_path):
    out = tmp_path / "mpb.json"
    write_mpb_catalog(make_dataset(tmp_path / "dataset"), out)
    entries = json.loads(out.read_text(encoding="utf-8"))["entries"]
    text = json.dumps(entries)

    for word in ("pitch", '"melody"', "onset", "duration", "notes", "chords"):
        assert word not in text
    for entry in entries:
        for value in entry.get("facts", {}).values():
            assert not (isinstance(value, list) and len(value) > 2)


def catalog_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    add_catalog_parser(parser.add_subparsers(dest="command", required=True))
    return parser


def test_catalog_analyze_writes_the_file_and_prints_the_counts(tmp_path, capsys):
    out = tmp_path / "mpb.json"
    args = catalog_parser().parse_args(
        [
            "catalog",
            "analyze",
            "--dataset",
            str(make_dataset(tmp_path / "d")),
            "--out",
            str(out),
            "--authors",
            str(tmp_path / "no-authors.json"),
        ]
    )
    args.handler(args)

    printed = capsys.readouterr().out
    assert "5 entries, 3 with a download route, 2 errors" in printed
    assert out.exists()
