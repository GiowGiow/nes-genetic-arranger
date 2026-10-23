"""The collection registry and the commands that manage it (`catalog.registry`).

`arranger/data/catalog/collections.json` lists every collection the app offers, the built-in ones
included: where its catalog file is, what it is called, in which order its playlist comes, whether
it is on, and the command that rebuilds it. These tests run on a throwaway repository (a temporary
folder with the registry and a few small catalog files in it), so nothing touches the real data.
"""

import json
from pathlib import Path

import pytest

from catalog.registry import (
    BUILTIN_COLLECTIONS,
    add_remote,
    list_collections,
    move_before,
    read_registry,
    rebuild_collection,
    register,
    remove_collection,
    rename_collection,
    set_enabled,
    set_lazy,
    set_order,
    show_collection,
    write_registry,
)
from main import main

REPO = Path(__file__).resolve().parents[2]
CATALOG = Path("arranger/data/catalog")


def write_catalog(root: Path, source: str, entries: list[dict]) -> Path:
    """A minimal catalog file of a source, with the envelope the real ones have."""
    path = root / CATALOG / f"{source}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    envelope = {
        "source": source,
        "name": source,
        "home": "https://example.org",
        "license": "test license",
        "credit": "test credit",
        "note": "test note",
        "generated": "test",
        "entries": entries,
    }
    path.write_text(json.dumps(envelope), encoding="utf-8")
    return path


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A repository with the built-in collections' small catalog files and no registry yet."""
    write_catalog(
        tmp_path,
        "examples",
        [{"id": "a", "t": "A", "license": "public-domain", "route": {"abc": "data/a.abc"}}],
    )
    write_catalog(
        tmp_path,
        "mpb",
        [
            {
                "id": f"m{n}",
                "t": f"M{n}",
                "license": "all-rights-reserved",
                "route": {"download": f"https://example.org/{n}.mid"},
            }
            for n in range(3)
        ],
    )
    return tmp_path


def ids(root: Path) -> list[str]:
    return [record["id"] for record in read_registry(root)]


# --- The registry file ---


def test_a_repository_without_a_registry_has_the_built_in_collections_in_the_apps_order(repo):
    records = read_registry(repo)

    assert [record["id"] for record in records] == [
        "examples",
        "mpb",
        "public-domain",
        "nottingham",
        "pdmx",
    ]
    assert [record["name"] for record in records] == [
        "Examples",
        "MPB",
        "Choro & public domain",
        "Folk tunes",
        "Classical & standards",
    ]
    assert [record["kind"] for record in records] == ["abc", "remote", "abc", "abc", "abc"]
    assert [record["lazy"] for record in records] == [False, True, False, False, False]
    assert all(record["enabled"] for record in records)
    assert not (repo / CATALOG / "collections.json").exists()  # reading writes nothing


def test_the_committed_registry_matches_the_built_in_collections_and_points_at_real_files():
    registry = json.loads((REPO / CATALOG / "collections.json").read_text(encoding="utf-8"))

    records = registry["collections"]
    committed = {record["id"]: record for record in records}
    for builtin in BUILTIN_COLLECTIONS:
        assert committed[builtin["id"]] == builtin
    for record in records:
        assert (REPO / "arranger" / record["path"]).exists(), record["id"]


def test_a_record_names_its_file_kind_order_and_the_command_that_rebuilds_it():
    for record in BUILTIN_COLLECTIONS:
        assert set(record) == {
            "id",
            "path",
            "name",
            "kind",
            "lazy",
            "order",
            "enabled",
            "generated",
        }
        assert record["path"] == f"data/catalog/{record['id']}.json"
        assert "uv run src/main.py" in record["generated"]


def test_writing_sorts_by_order_then_name_and_reading_gives_it_back(repo):
    records = read_registry(repo)
    records.append({**records[0], "id": "zzz", "name": "Zzz", "order": 5})
    records.append({**records[0], "id": "aaa", "name": "Aaa", "order": 5})

    write_registry(repo, records)

    assert ids(repo) == ["aaa", "zzz", "examples", "mpb", "public-domain", "nottingham", "pdmx"]
    text = (repo / CATALOG / "collections.json").read_text(encoding="utf-8")
    assert text.endswith("\n") and '"collections"' in text


def test_a_registry_with_a_bad_record_is_refused_with_the_reason(repo):
    path = repo / CATALOG / "collections.json"
    path.write_text(json.dumps({"collections": [{"id": "x", "path": "p"}]}), encoding="utf-8")

    with pytest.raises(ValueError, match="'x'.*name"):
        read_registry(repo)


def test_registering_adds_a_record_or_replaces_the_one_with_the_same_id(repo):
    new = {
        "id": "mine",
        "path": "data/catalog/mine.json",
        "name": "Mine",
        "kind": "local-midi",
        "lazy": False,
        "order": 100,
        "enabled": True,
        "generated": "uv run src/main.py collection build songs/mine",
    }
    register(repo, new)
    register(repo, {**new, "name": "Mine again"})

    records = read_registry(repo)
    assert [record["name"] for record in records if record["id"] == "mine"] == ["Mine again"]
    assert len(records) == 6


# --- list and show ---


def test_list_shows_one_row_per_collection_with_songs_size_and_flags(repo):
    table = list_collections(repo)

    lines = table.splitlines()
    assert lines[0].split() == [
        "id",
        "name",
        "kind",
        "songs",
        "enabled",
        "order",
        "size",
        "lazy",
    ]
    mpb = next(line for line in lines if line.startswith("mpb"))
    assert " 3 " in mpb and "remote" in mpb and "yes" in mpb
    pdmx = next(line for line in lines if line.startswith("pdmx"))
    assert "missing" in pdmx  # in the registry, but its file is not there


def test_show_prints_the_envelope_the_first_songs_and_counts_by_license_and_route(repo):
    text = show_collection(repo, "mpb", first=2)

    assert "id: mpb" in text and "kind: remote" in text
    assert "license: test license" in text
    assert "M0" in text and "M1" in text and "M2" not in text
    assert "all-rights-reserved: 3" in text
    assert "download: 3" in text


def test_show_of_an_unknown_collection_names_the_known_ones(repo):
    with pytest.raises(ValueError, match="no collection 'nowhere'.*examples"):
        show_collection(repo, "nowhere")


# --- enable, disable, rename, order, move, lazy ---


def test_disable_and_enable_flip_the_flag_and_keep_the_catalog_file(repo):
    set_enabled(repo, "mpb", False)
    assert next(r for r in read_registry(repo) if r["id"] == "mpb")["enabled"] is False
    assert (repo / CATALOG / "mpb.json").exists()

    set_enabled(repo, "mpb", True)
    assert next(r for r in read_registry(repo) if r["id"] == "mpb")["enabled"] is True


def test_rename_changes_the_name_the_playlist_shows(repo):
    rename_collection(repo, "examples", "Starter songs")

    assert next(r for r in read_registry(repo) if r["id"] == "examples")["name"] == "Starter songs"
    with pytest.raises(ValueError, match="empty"):
        rename_collection(repo, "examples", "  ")


def test_order_puts_a_collection_among_the_others_by_its_number(repo):
    set_order(repo, "pdmx", 15)

    assert ids(repo) == ["examples", "pdmx", "mpb", "public-domain", "nottingham"]


def test_move_before_puts_a_collection_just_before_another_and_keeps_the_rest_in_order(repo):
    move_before(repo, "pdmx", "mpb")

    assert ids(repo) == ["examples", "pdmx", "mpb", "public-domain", "nottingham"]
    orders = [record["order"] for record in read_registry(repo)]
    assert orders == sorted(set(orders))  # distinct, so the order is the same everywhere

    with pytest.raises(ValueError, match="before itself"):
        move_before(repo, "mpb", "mpb")


def test_lazy_on_and_off_change_when_the_file_is_read(repo):
    set_lazy(repo, "pdmx", True)
    assert next(r for r in read_registry(repo) if r["id"] == "pdmx")["lazy"] is True
    set_lazy(repo, "mpb", False)
    assert next(r for r in read_registry(repo) if r["id"] == "mpb")["lazy"] is False


def test_the_first_change_writes_the_whole_registry_with_the_built_ins(repo):
    set_enabled(repo, "mpb", False)

    assert (repo / CATALOG / "collections.json").exists()
    assert ids(repo) == ["examples", "mpb", "public-domain", "nottingham", "pdmx"]


# --- remove ---


def local_record(path: str = "data/catalog/mine.json") -> dict:
    return {
        "id": "mine",
        "path": path,
        "name": "Mine",
        "kind": "local-midi",
        "lazy": False,
        "order": 100,
        "enabled": True,
        "generated": "uv run src/main.py collection build songs/mine",
        "dir": "songs/mine",
    }


def test_removing_a_collection_you_added_unregisters_it_and_deletes_its_catalog_file(repo):
    write_catalog(repo, "mine", [])
    midi = repo / "songs/mine/a.mid"
    midi.parent.mkdir(parents=True)
    midi.write_bytes(b"MThd")
    register(repo, local_record())

    remove_collection(repo, "mine")

    assert "mine" not in ids(repo)
    assert not (repo / CATALOG / "mine.json").exists()
    assert midi.exists()  # the MIDI files are the student's


def test_a_built_in_collection_is_not_removed_without_force(repo):
    with pytest.raises(ValueError, match="built-in.*--force"):
        remove_collection(repo, "mpb")
    assert "mpb" in ids(repo)

    remove_collection(repo, "mpb", force=True)
    assert "mpb" not in ids(repo)
    assert not (repo / CATALOG / "mpb.json").exists()


def test_committed_lead_sheets_are_deleted_only_with_delete_files(repo):
    write_catalog(repo, "nottingham", [])
    abc = repo / "data/catalog/abc/nottingham/jigs.abc"
    abc.parent.mkdir(parents=True)
    abc.write_text("X:1\n", encoding="utf-8")

    remove_collection(repo, "nottingham", force=True)
    assert abc.exists()

    remove_collection(repo, "pdmx", force=True)  # no files at all: nothing to delete
    write_catalog(repo, "public-domain", [])
    (repo / "data/catalog/abc/public-domain").mkdir(parents=True)
    (repo / "data/catalog/abc/public-domain/x.abc").write_text("X:1\n", encoding="utf-8")
    remove_collection(repo, "public-domain", force=True, delete_files=True)
    assert not (repo / "data/catalog/abc/public-domain").exists()


def test_the_examples_lead_sheets_are_never_deleted(repo):
    sheet = repo / "data/leadsheets/a.abc"
    sheet.parent.mkdir(parents=True)
    sheet.write_text("X:1\n", encoding="utf-8")

    remove_collection(repo, "examples", force=True, delete_files=True)

    assert sheet.exists()


def test_removing_an_unknown_collection_says_so(repo):
    with pytest.raises(ValueError, match="no collection 'nowhere'"):
        remove_collection(repo, "nowhere")


# --- rebuild ---


class Recorder:
    """Stands in for `main.main`: records the commands and answers with an exit code."""

    def __init__(self, code: int = 0):
        self.commands: list[list[str]] = []
        self.code = code

    def __call__(self, argv: list[str]) -> int:
        self.commands.append(argv)
        return self.code


def test_rebuilding_a_built_in_runs_its_generator_then_the_popularity_step(repo):
    run = Recorder()

    rebuild_collection(repo, "examples", run=run)

    assert run.commands == [["catalog", "examples"], ["catalog", "popularity"]]


def test_rebuilding_a_collection_that_needs_the_mpb_study_copy_refuses_without_it(repo, tmp_path):
    run = Recorder()

    with pytest.raises(ValueError, match="--dataset"):
        rebuild_collection(repo, "mpb", run=run)
    with pytest.raises(ValueError, match="metadata.csv"):
        rebuild_collection(repo, "mpb", dataset=tmp_path / "nowhere", run=run)
    assert run.commands == []

    study = tmp_path / "study"
    study.mkdir()
    (study / "metadata.csv").write_text("path\n", encoding="utf-8")
    rebuild_collection(repo, "mpb", dataset=study, run=run)
    assert run.commands == [
        ["catalog", "analyze", "--dataset", str(study)],
        ["catalog", "popularity"],
    ]


def test_rebuilding_a_collection_that_needs_downloaded_data_says_what_to_fetch(repo):
    with pytest.raises(ValueError, match="data/raw/nottingham"):
        rebuild_collection(repo, "nottingham", run=Recorder())


def test_rebuilding_a_local_midi_collection_runs_collection_build_on_its_folder(repo):
    register(repo, local_record())
    run = Recorder()

    rebuild_collection(repo, "mine", run=run)

    assert run.commands == [["collection", "build", "songs/mine", "--root", str(repo)]]


def test_a_rebuild_whose_step_fails_stops_and_says_which(repo):
    with pytest.raises(ValueError, match="catalog examples.*exit code 1"):
        rebuild_collection(repo, "examples", run=Recorder(code=1))


# --- add-remote ---


def write_list(path: Path, rows: list[list[str]]) -> Path:
    path.write_text("\n".join(",".join(row) for row in rows) + "\n", encoding="utf-8")
    return path


def test_add_remote_lists_download_links_without_fetching_anything(repo):
    songs = write_list(
        repo / "links.csv",
        [
            ["title", "composer", "url"],
            ["Tune One", "Someone", "https://example.org/files/one.mid"],
            ["Tune Two", "Someone Else", "https://example.org/files/two.mid"],
        ],
    )

    entries = add_remote(repo, "links", name="Links", source_list=songs)

    catalog = json.loads((repo / CATALOG / "links.json").read_text(encoding="utf-8"))
    assert catalog["source"] == "links" and catalog["name"] == "Links"
    assert [entry["t"] for entry in catalog["entries"]] == ["Tune One", "Tune Two"]
    first = catalog["entries"][0]
    assert first["id"] == "tune-one" and first["source"] == "links"
    assert first["c"] == "Someone"
    assert first["route"] == {"download": "https://example.org/files/one.mid"}
    assert "facts" not in first and isinstance(first["seed"], int)
    assert len(entries) == 2
    record = next(r for r in read_registry(repo) if r["id"] == "links")
    assert record["kind"] == "remote" and record["enabled"] and record["name"] == "Links"
    assert "add-remote links" in record["generated"]


def test_add_remote_reads_json_too_and_the_optional_columns(repo):
    songs = repo / "links.json"
    songs.write_text(
        json.dumps(
            [
                {
                    "title": "Tune",
                    "composer": "C",
                    "performer": "P",
                    "url": "https://example.org/t.mid",
                    "popularity": 12,
                    "license": "CC-BY-4.0",
                }
            ]
        ),
        encoding="utf-8",
    )

    add_remote(repo, "links", name="Links", source_list=songs)

    entry = json.loads((repo / CATALOG / "links.json").read_text(encoding="utf-8"))["entries"][0]
    assert (entry["p"], entry["pop"], entry["license"]) == ("P", 12, "CC-BY-4.0")


def test_add_remote_refuses_a_row_without_a_title_or_with_a_link_that_is_not_http(repo):
    bad_url = write_list(repo / "a.csv", [["title", "url"], ["T", "file:///etc/passwd"]])
    no_title = write_list(repo / "b.csv", [["title", "url"], ["", "https://example.org/t.mid"]])

    with pytest.raises(ValueError, match="http"):
        add_remote(repo, "links", name="Links", source_list=bad_url)
    with pytest.raises(ValueError, match="title"):
        add_remote(repo, "links", name="Links", source_list=no_title)
    assert not (repo / CATALOG / "links.json").exists()


def test_add_remote_keeps_ids_unique_when_titles_repeat(repo):
    songs = write_list(
        repo / "links.csv",
        [
            ["title", "url"],
            ["Same", "https://example.org/1.mid"],
            ["Same", "https://example.org/2.mid"],
        ],
    )

    entries = add_remote(repo, "links", name="Links", source_list=songs)

    assert [entry["id"] for entry in entries] == ["same", "same-2"]


def test_a_remote_collection_rebuilds_from_its_recorded_list(repo):
    songs = write_list(repo / "links.csv", [["title", "url"], ["T", "https://example.org/t.mid"]])
    add_remote(repo, "links", name="Links", source_list=songs)
    run = Recorder()

    rebuild_collection(repo, "links", run=run)

    assert run.commands == [
        [
            "collection",
            "add-remote",
            "links",
            "--name",
            "Links",
            "--from",
            "links.csv",
            "--root",
            str(repo),
        ]
    ]


def test_a_collection_id_must_be_a_lowercase_slug_that_is_not_taken_by_another_kind(repo):
    songs = write_list(repo / "l.csv", [["title", "url"], ["T", "https://example.org/t.mid"]])
    for bad in ("My Links", "-x", "popular", "yours", "local"):
        with pytest.raises(ValueError, match="id"):
            add_remote(repo, bad, name="x", source_list=songs)
    with pytest.raises(ValueError, match="built-in"):
        add_remote(repo, "mpb", name="x", source_list=songs)


# --- command line ---


def test_the_management_commands_work_from_the_command_line(repo, capsys):
    root = ["--root", str(repo)]

    assert main(["collection", "list", *root]) == 0
    assert "examples" in capsys.readouterr().out
    assert main(["collection", "show", "mpb", *root]) == 0
    assert "kind: remote" in capsys.readouterr().out
    assert main(["collection", "disable", "mpb", *root]) == 0
    assert main(["collection", "enable", "mpb", *root]) == 0
    assert main(["collection", "rename", "mpb", "Brazilian", *root]) == 0
    assert main(["collection", "order", "pdmx", "15", *root]) == 0
    assert main(["collection", "move", "pdmx", "--before", "examples", *root]) == 0
    assert main(["collection", "lazy", "pdmx", "on", *root]) == 0
    records = {record["id"]: record for record in read_registry(repo)}
    assert records["mpb"]["name"] == "Brazilian" and records["mpb"]["enabled"]
    assert records["pdmx"]["lazy"] is True
    assert ids(repo)[0] == "pdmx"
    assert main(["collection", "remove", "mpb", *root]) == 1
    assert "--force" in capsys.readouterr().err
    assert main(["collection", "remove", "mpb", "--force", *root]) == 0
