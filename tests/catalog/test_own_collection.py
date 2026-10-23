"""The student's own MIDI collections: find, preview and build (`own_collection.py`).

A collection is a folder of the repository that holds MIDI files the student may redistribute.
The student sets one license for the whole folder; the tool finds each song's title, composer,
popularity and whether the composition is in the public domain, and `build` turns the folder
into a catalog file the app loads as a playlist. These tests write tiny synthetic MIDI files
into a throwaway repository and replace every online lookup (MusicBrainz, Wikidata, Wikipedia)
with a fake that answers from a table, so no network and no third-party file is involved.
"""

import hashlib
import json
import tomllib
from pathlib import Path

import pretty_midi
import pytest

from catalog.own_collection import (
    ALLOWED_LICENSE_HELP,
    Lookups,
    build_collection,
    canonical_license,
    init_collection,
    preview_collection,
    read_sidecar,
)
from catalog.registry import read_registry, set_enabled, set_lazy
from main import main

ENTITY = "http://www.wikidata.org/entity/"
DEATH_YEARS = {  # what the fake Wikidata knows: name -> [(qid, year of death or None for alive)]
    "Johann Sebastian Bach": [("Q1339", 1750)],
    "Ludwig van Beethoven": [("Q255", 1827), ("Q256", 1773)],  # a grandfather shares the name
    "Living Person": [("Q999", None)],
    "Bach": [("Q777", 1953)],  # some other Bach: a bare surname proves nothing
}
WORKS = {  # what the fake MusicBrainz knows: work title -> composer
    "Air on the G String": "Johann Sebastian Bach",
    "Ode to Joy": "Ludwig van Beethoven",
    "Living Song": "Living Person",
}
POPULARITY = {"Air on the G String": 5000, "Ode to Joy": 9000}


def write_song(path: Path, bars: int = 8) -> Path:
    """A 4/4 song at 120 BPM: a voice, a bass and drums (the analysis finds the voice)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    midi = pretty_midi.PrettyMIDI(initial_tempo=120.0)
    beat = 0.5
    voice = pretty_midi.Instrument(program=73, name="voz")
    bass = pretty_midi.Instrument(program=33, name="bass")
    drums = pretty_midi.Instrument(program=0, is_drum=True, name="drums")
    for bar in range(bars):
        start = bar * 4 * beat
        drums.notes.append(pretty_midi.Note(90, 36, start, start + 0.1))
        for step, pitch in enumerate((72, 76, 79, 76)):
            voice.notes.append(
                pretty_midi.Note(90, pitch, start + step * beat, start + (step + 1) * beat)
            )
        bass.notes.append(pretty_midi.Note(80, 36, start, start + 4 * beat))
    midi.instruments += [bass, voice, drums]
    midi.write(str(path))
    return path


def fake_musicbrainz(url: str) -> dict:
    from urllib.parse import parse_qs, urlparse

    title = parse_qs(urlparse(url).query)["query"][0].split('"')[1]
    if title not in WORKS:
        return {"works": []}
    return {
        "works": [
            {
                "id": "w-" + title[:3],
                "score": 100,
                "title": title,
                "relations": [{"type": "composer", "artist": {"name": WORKS[title]}}],
            }
        ]
    }


def fake_wikidata(query: str) -> dict:
    rows = []
    for name, people in DEATH_YEARS.items():
        if f'"{name}"@' not in query:
            continue
        for qid, year in people:
            row = {
                "name": {"value": name},
                "person": {"value": ENTITY + qid},
                "occupation": {"value": ENTITY + "Q36834"},
            }
            if year:
                row["death"] = {"type": "literal", "value": f"{year}-01-01T00:00:00Z"}
            rows.append(row)
    return {"results": {"bindings": rows}}


def fake_popularity(entries, cache_dir) -> list[int]:
    return [POPULARITY.get(entry["t"], 0) for entry in entries]


@pytest.fixture
def lookups() -> Lookups:
    return Lookups(
        musicbrainz=fake_musicbrainz,
        sparql=fake_wikidata,
        popularity=fake_popularity,
        sleep=lambda seconds: None,
        log=lambda line: None,
    )


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A throwaway repository root: it only needs the app folder the catalog files go into."""
    (tmp_path / "arranger").mkdir()
    return tmp_path


def baroque(repo: Path) -> Path:
    """A folder with two songs MusicBrainz knows, named the way people name MIDI files."""
    folder = repo / "songs/baroque"
    write_song(folder / "Bach - Air on the G String.mid", bars=8)
    write_song(folder / "ode_to_joy.mid", bars=12)
    return folder


def catalog_of(repo: Path, collection_id: str) -> dict:
    return json.loads((repo / f"arranger/data/catalog/{collection_id}.json").read_text("utf-8"))


def edit(folder: Path, old: str, new: str, count: int = 1) -> None:
    """Edit the sidecar the way the student does: replace some text in it."""
    sidecar = folder / "collection.toml"
    text = sidecar.read_text(encoding="utf-8")
    assert old in text, f"{old!r} is not in the sidecar:\n{text}"
    sidecar.write_text(text.replace(old, new, count), encoding="utf-8")


# --- Licenses ---


@pytest.mark.parametrize(
    ("typed", "canonical"),
    [
        ("public-domain", "public-domain"),
        ("Public-Domain", "public-domain"),
        ("cc0-1.0", "CC0-1.0"),
        ("CC0", "CC0-1.0"),
        ("cc-by-4.0", "CC-BY-4.0"),
        ("CC-BY-SA-3.0", "CC-BY-SA-3.0"),
        ("own-work", "own-work"),
        ("MIT", "MIT"),
        ("GPL-3.0-or-later", "GPL-3.0-or-later"),
    ],
)
def test_licenses_that_allow_redistribution_are_accepted_and_spelled_one_way(typed, canonical):
    assert canonical_license(typed) == canonical


@pytest.mark.parametrize(
    "typed",
    ["", "all-rights-reserved", "CC-BY-NC-4.0", "CC-BY-ND-4.0", "free to use", "unknown"],
)
def test_a_license_that_does_not_allow_redistribution_is_refused(typed):
    assert canonical_license(typed) is None


def test_the_help_text_names_the_accepted_licenses():
    assert "public-domain" in ALLOWED_LICENSE_HELP
    assert "CC-BY-" in ALLOWED_LICENSE_HELP


# --- init ---


def test_init_finds_each_songs_title_and_composer_and_writes_them_in_the_sidecar(repo, lookups):
    folder = baroque(repo)
    (folder / "notes.txt").write_text("not a MIDI file")

    sidecar, added = init_collection(
        folder, root=repo, lookups=lookups, license_text="CC0-1.0", source="https://example.org"
    )

    assert sidecar == folder / "collection.toml"
    assert added == ["Bach - Air on the G String.mid", "ode_to_joy.mid"]
    collection, songs = read_sidecar(folder)
    assert collection.id == "baroque" and collection.name == "Baroque"
    assert (collection.license, collection.source) == ("CC0-1.0", "https://example.org")
    assert collection.default_sort == "popularity"
    air, ode = songs
    assert (air.title, air.composer) == ("Air on the G String", "Johann Sebastian Bach")
    assert (ode.title, ode.composer) == ("Ode to Joy", "Ludwig van Beethoven")
    text = (folder / "collection.toml").read_text(encoding="utf-8")
    assert "title from file name" in text and "composer from MusicBrainz (high)" in text
    assert "composition public domain: yes" in text and "died 1750" in text
    assert '1 "voz"' in text  # the tracks, to help choose a melody track
    assert "# album = " in text and "# popularity = 5000" in text  # what was found, as a default


def test_init_without_a_license_leaves_it_empty_and_says_what_to_put(repo, lookups):
    folder = baroque(repo)

    init_collection(folder, root=repo, lookups=lookups)

    collection, _ = read_sidecar(folder)
    assert collection.license == ""
    assert "public-domain" in (folder / "collection.toml").read_text(encoding="utf-8")


def test_init_marks_a_low_confidence_match_so_the_student_can_fix_it(repo, lookups):
    folder = repo / "songs/own"
    write_song(folder / "my_own_tune.mid")

    init_collection(folder, root=repo, lookups=lookups)

    text = (folder / "collection.toml").read_text(encoding="utf-8")
    assert "low confidence" in text
    _, songs = read_sidecar(folder)
    assert songs[0].title == "My Own Tune" and songs[0].composer == ""


def test_the_sidecar_is_valid_toml_even_with_quotes_in_a_title(repo, lookups):
    folder = repo / "songs/own"
    write_song(folder / 'Say "Hi".mid')

    sidecar, _ = init_collection(folder, root=repo, lookups=lookups)

    assert tomllib.loads(sidecar.read_text(encoding="utf-8"))["song"][0]["title"] == 'Say "Hi"'


def test_init_refuses_a_folder_outside_the_repository(repo, tmp_path_factory, lookups):
    outside = tmp_path_factory.mktemp("elsewhere")
    write_song(outside / "song.mid")

    with pytest.raises(ValueError, match="inside the repository"):
        init_collection(outside, root=repo, lookups=lookups)
    assert not (outside / "collection.toml").exists()


def test_init_refuses_a_folder_without_midi_files(repo, lookups):
    (repo / "songs/empty").mkdir(parents=True)
    with pytest.raises(ValueError, match="no .mid or .midi file"):
        init_collection(repo / "songs/empty", root=repo, lookups=lookups)


def test_init_again_adds_only_the_new_files_and_keeps_the_students_edits(repo, lookups):
    folder = baroque(repo)
    init_collection(folder, root=repo, lookups=lookups)
    edit(folder, 'title = "Ode to Joy"', 'title = "Ode an die Freude"')
    before = (folder / "collection.toml").read_text(encoding="utf-8")

    write_song(folder / "new_song.mid")
    _, added = init_collection(folder, root=repo, lookups=lookups)

    assert added == ["new_song.mid"]
    after = (folder / "collection.toml").read_text(encoding="utf-8")
    assert after.startswith(before)
    _, songs = read_sidecar(folder)
    assert [song.title for song in songs] == [
        "Air on the G String",
        "Ode an die Freude",
        "New Song",
    ]
    assert init_collection(folder, root=repo, lookups=lookups)[1] == []


def test_init_takes_the_id_and_name_from_the_options(repo, lookups):
    folder = baroque(repo)

    init_collection(folder, root=repo, lookups=lookups, collection_id="my-songs", name="My songs")

    collection, _ = read_sidecar(folder)
    assert (collection.id, collection.name) == ("my-songs", "My songs")


@pytest.mark.parametrize("bad_id", ["My Songs", "mpb", "popular", "-x"])
def test_a_collection_id_is_a_lowercase_slug_that_no_built_in_source_uses(repo, lookups, bad_id):
    folder = baroque(repo)
    with pytest.raises(ValueError, match="id"):
        init_collection(folder, root=repo, lookups=lookups, collection_id=bad_id)


def test_a_misspelled_field_in_the_sidecar_is_reported(repo, lookups):
    folder = baroque(repo)
    init_collection(folder, root=repo, lookups=lookups)
    edit(folder, "default_sort = ", "defalt_sort = ")

    with pytest.raises(ValueError, match="defalt_sort"):
        read_sidecar(folder)


# --- build: licenses ---


def test_build_without_any_license_refuses_and_says_how_to_set_one(repo, lookups):
    folder = baroque(repo)

    with pytest.raises(ValueError) as refusal:
        build_collection(folder, root=repo, lookups=lookups)

    message = str(refusal.value)
    assert "no license" in message and "--license" in message
    assert "public-domain" in message  # the accepted licenses
    assert not (repo / "arranger/data/catalog/baroque.json").exists()
    assert not (repo / "arranger/data/catalog/collections.json").exists()


def test_build_refuses_a_license_that_does_not_allow_redistribution(repo, lookups):
    folder = baroque(repo)

    with pytest.raises(ValueError, match="CC-BY-NC-4.0"):
        build_collection(folder, root=repo, lookups=lookups, license_text="CC-BY-NC-4.0")


def test_build_needs_a_source_for_a_license_that_asks_for_credit(repo, lookups):
    folder = baroque(repo)

    with pytest.raises(ValueError, match="source"):
        build_collection(folder, root=repo, lookups=lookups, license_text="CC-BY-4.0")

    build_collection(
        folder, root=repo, lookups=lookups, license_text="CC-BY-4.0", source="https://example.org"
    )
    entry = catalog_of(repo, "baroque")["entries"][0]
    assert entry["license"] == "CC-BY-4.0" and entry["credit"] == "https://example.org"


def test_a_license_per_song_stands_in_for_the_collections_license(repo, lookups):
    folder = baroque(repo)
    init_collection(folder, root=repo, lookups=lookups)
    edit(folder, '# license = ""', 'license = "own-work"', count=2)

    build_collection(folder, root=repo, lookups=lookups)

    assert {e["license"] for e in catalog_of(repo, "baroque")["entries"]} == {"own-work"}


def test_one_song_without_a_license_and_no_collection_license_is_named_in_the_refusal(
    repo, lookups
):
    folder = baroque(repo)
    init_collection(folder, root=repo, lookups=lookups)
    edit(folder, '# license = ""', 'license = "own-work"', count=1)

    with pytest.raises(ValueError, match="ode_to_joy.mid"):
        build_collection(folder, root=repo, lookups=lookups)


def test_a_song_license_overrides_the_collections(repo, lookups):
    folder = baroque(repo)
    init_collection(folder, root=repo, lookups=lookups, license_text="own-work")
    edit(folder, '# license = ""', 'license = "CC0-1.0"', count=1)

    build_collection(folder, root=repo, lookups=lookups)

    licenses = {e["id"]: e["license"] for e in catalog_of(repo, "baroque")["entries"]}
    assert sorted(licenses.values()) == ["CC0-1.0", "own-work"]


# --- build: the public-domain check ---


def living_song(folder: Path) -> None:
    write_song(folder / "Living Person - Living Song.mid")


def test_with_the_public_domain_license_a_song_whose_composer_is_alive_is_left_out(repo, lookups):
    folder = baroque(repo)
    living_song(folder)

    result = build_collection(folder, root=repo, lookups=lookups, license_text="public-domain")

    assert sorted(e["t"] for e in result.entries) == ["Air on the G String", "Ode to Joy"]
    assert [song.file for song in result.unconfirmed] == ["Living Person - Living Song.mid"]
    assert "Living Person" in result.unconfirmed[0].reason


def test_include_unconfirmed_puts_those_songs_in_the_catalog_too(repo, lookups):
    folder = baroque(repo)
    living_song(folder)

    result = build_collection(
        folder, root=repo, lookups=lookups, license_text="public-domain", include_unconfirmed=True
    )

    assert len(result.entries) == 3 and result.unconfirmed == []


def test_a_composer_wikidata_does_not_know_counts_as_not_confirmed(repo, lookups):
    folder = repo / "songs/own"
    write_song(folder / "my_own_tune.mid")

    result = build_collection(folder, root=repo, lookups=lookups, license_text="public-domain")

    assert result.entries == [] and len(result.unconfirmed) == 1


def test_a_bare_surname_proves_nothing_even_if_wikidata_knows_someone_by_it(repo, lookups):
    folder = repo / "songs/own"
    write_song(folder / "Bach - Some Tune.mid")  # MusicBrainz knows no such work: "Bach" stays

    text = preview_collection(folder, root=repo, lookups=lookups, license_text="public-domain")

    assert "composition public domain: unknown" in text
    assert "only a surname" in text and "NOT INCLUDED" in text


def test_two_people_who_share_a_name_and_both_died_long_ago_make_the_composition_free(
    repo, lookups
):
    folder = repo / "songs/own"
    write_song(folder / "ode_to_joy.mid")  # MusicBrainz: Ludwig van Beethoven; Wikidata: two people

    result = build_collection(folder, root=repo, lookups=lookups, license_text="public-domain")

    assert len(result.entries) == 1 and result.unconfirmed == []
    text = preview_collection(folder, root=repo, lookups=lookups, license_text="public-domain")
    assert "composition public domain: yes" in text and "share the name" in text


def test_the_student_can_state_that_a_composition_is_public_domain(repo, lookups):
    folder = repo / "songs/own"
    write_song(folder / "my_own_tune.mid")
    init_collection(folder, root=repo, lookups=lookups, license_text="public-domain")
    edit(folder, "# public_domain = true", "public_domain = true")

    result = build_collection(folder, root=repo, lookups=lookups)

    assert len(result.entries) == 1


def test_other_licenses_do_not_check_the_composer_but_the_preview_reports_it(repo, lookups):
    folder = baroque(repo)
    living_song(folder)

    result = build_collection(folder, root=repo, lookups=lookups, license_text="CC0-1.0")
    text = preview_collection(folder, root=repo, lookups=lookups, license_text="CC0-1.0")

    assert len(result.entries) == 3
    assert "composition public domain: no" in text


# --- build: the catalog file ---


def test_build_with_no_sidecar_runs_the_whole_lookup_and_writes_the_catalog(repo, lookups):
    folder = baroque(repo)

    result = build_collection(folder, root=repo, lookups=lookups, license_text="CC0-1.0")

    assert not (folder / "collection.toml").exists()
    assert result.catalog_path == repo / "arranger/data/catalog/baroque.json"
    catalog = catalog_of(repo, "baroque")
    assert catalog["source"] == "baroque" and catalog["name"] == "Baroque"
    assert {"home", "license", "credit", "note", "generated"} <= set(catalog)
    assert "CC0-1.0" in catalog["license"]
    assert "collection build songs/baroque" in catalog["generated"]
    air, ode = catalog["entries"]  # sorted by title, like every catalog file
    assert (air["t"], ode["t"]) == ("Air on the G String", "Ode to Joy")
    assert air["id"] == "bach-air-on-the-g-string"
    assert (air["c"], air["source"], air["license"]) == (
        "Johann Sebastian Bach",
        "baroque",
        "CC0-1.0",
    )
    assert air["route"] == {"midi": "../songs/baroque/Bach - Air on the G String.mid"}
    assert air["pop"] == 5000 and ode["pop"] == 9000
    assert air["album"] == "Johann Sebastian Bach"  # the composer, unless set otherwise
    assert air["seed"] == int.from_bytes(
        hashlib.sha256(b"baroque:bach-air-on-the-g-string").digest()[:4], "big"
    )
    facts = air["facts"]
    assert facts["melody_track"] == 1 and facts["bars"] == [0, 8] and facts["n_bars"] == 8
    assert facts["meter"] == "4/4" and facts["key"] == "C major" and facts["tempo_bpm"] == 120.0
    assert facts["drums"] is True and len(facts["sha256"]) == 64
    assert facts["overrides"] == {"max_generations": 4000, "stagnation_window": 400}
    assert "error" not in air


def test_the_sidecar_overrides_what_was_found(repo, lookups):
    folder = baroque(repo)
    init_collection(folder, root=repo, lookups=lookups, license_text="own-work")
    edit(folder, 'title = "Ode to Joy"', 'title = "Ode an die Freude"')
    edit(folder, '# performer = ""', 'performer = "Me"', count=1)
    edit(folder, "# popularity = 5000", "popularity = 77", count=1)

    build_collection(folder, root=repo, lookups=lookups)

    by_title = {e["t"]: e for e in catalog_of(repo, "baroque")["entries"]}
    assert "Ode an die Freude" in by_title
    air = by_title["Air on the G String"]
    assert (air["p"], air["pop"]) == ("Me", 77)


def test_a_subfolder_is_the_album_of_its_songs_and_otherwise_the_composer_is(repo, lookups):
    folder = repo / "songs/mixed"
    write_song(folder / "Baroque Hits" / "Bach - Air on the G String.mid")
    write_song(folder / "ode_to_joy.mid")

    build_collection(folder, root=repo, lookups=lookups, license_text="CC0-1.0")

    albums = {e["t"]: e["album"] for e in catalog_of(repo, "mixed")["entries"]}
    assert albums == {"Air on the G String": "Baroque Hits", "Ode to Joy": "Ludwig van Beethoven"}


def test_a_song_with_no_composer_found_has_no_album(repo, lookups):
    folder = repo / "songs/own"
    write_song(folder / "my_own_tune.mid")

    build_collection(folder, root=repo, lookups=lookups, license_text="own-work")

    assert "album" not in catalog_of(repo, "own")["entries"][0]


def test_a_skipped_song_is_not_in_the_catalog(repo, lookups):
    folder = baroque(repo)
    init_collection(folder, root=repo, lookups=lookups, license_text="own-work")
    edit(folder, "# skip = false", "skip = true", count=1)

    result = build_collection(folder, root=repo, lookups=lookups)

    assert len(result.entries) == 1


def test_build_uses_the_melody_track_and_bars_the_student_chose(repo, lookups):
    folder = repo / "songs/own"
    write_song(folder / "ode_to_joy.mid", bars=12)
    init_collection(folder, root=repo, lookups=lookups, license_text="own-work")
    edit(folder, "# melody_track = 1", "melody_track = 0")
    edit(folder, "# bars = [0, 12]", "bars = [2, 6]")

    build_collection(folder, root=repo, lookups=lookups)

    facts = catalog_of(repo, "own")["entries"][0]["facts"]
    assert facts["melody_track"] == 0 and facts["bars"] == [2, 6] and facts["n_bars"] == 4


def test_a_file_the_reader_cannot_reduce_stays_listed_with_its_error(repo, lookups):
    folder = baroque(repo)
    (folder / "broken.mid").write_bytes(b"MThd\x00\x00\x00\x06\x00\x01")

    result = build_collection(folder, root=repo, lookups=lookups, license_text="own-work")

    broken = next(entry for entry in result.entries if entry["id"] == "broken")
    assert "route" not in broken and broken["error"]
    assert result.problems == ["broken.mid: " + broken["error"]]


def test_build_registers_the_collection_in_the_registry_with_its_sidecar_settings(repo, lookups):
    folder = baroque(repo)
    init_collection(
        folder, root=repo, lookups=lookups, license_text="own-work", collection_id="my-songs"
    )
    edit(folder, 'description = ""', 'description = "Tunes I made"')
    edit(folder, "order = 100", "order = 25")
    edit(folder, 'default_sort = "popularity"', 'default_sort = "title"')

    build_collection(folder, root=repo, lookups=lookups)

    record = next(r for r in read_registry(repo) if r["id"] == "my-songs")
    assert record == {
        "id": "my-songs",
        "path": "data/catalog/my-songs.json",
        "name": "Baroque",
        "kind": "local-midi",
        "lazy": False,
        "order": 25,
        "enabled": True,
        "generated": "uv run src/main.py collection build songs/baroque",
        "description": "Tunes I made",
        "default_sort": "title",
        "dir": "songs/baroque",
    }


def test_building_again_keeps_the_flags_set_with_the_registry_commands(repo, lookups):
    folder = baroque(repo)
    build_collection(folder, root=repo, lookups=lookups, license_text="own-work")
    set_enabled(repo, "baroque", False)
    set_lazy(repo, "baroque", True)

    build_collection(folder, root=repo, lookups=lookups, license_text="own-work")

    record = next(r for r in read_registry(repo) if r["id"] == "baroque")
    assert record["enabled"] is False and record["lazy"] is True


def test_build_leaves_the_midi_files_and_the_sidecar_as_they_were(repo, lookups):
    folder = baroque(repo)
    init_collection(folder, root=repo, lookups=lookups, license_text="own-work")
    before = {path: path.read_bytes() for path in folder.iterdir()}

    build_collection(folder, root=repo, lookups=lookups)

    assert {path: path.read_bytes() for path in folder.iterdir()} == before


def test_two_builds_write_the_same_bytes(repo, lookups):
    folder = baroque(repo)
    build_collection(folder, root=repo, lookups=lookups, license_text="own-work")
    first = (repo / "arranger/data/catalog/baroque.json").read_bytes()
    build_collection(folder, root=repo, lookups=lookups, license_text="own-work")
    assert (repo / "arranger/data/catalog/baroque.json").read_bytes() == first


# --- preview ---


def test_preview_shows_the_playlist_as_the_app_will_and_where_each_fact_came_from(repo, lookups):
    folder = baroque(repo)
    write_song(folder / "my_own_tune.mid")

    def files() -> list[Path]:  # the cache of online answers (data/) is the only thing written
        return sorted(
            p.relative_to(repo) for p in repo.rglob("*") if p.relative_to(repo).parts[0] != "data"
        )

    files_before = files()

    output = preview_collection(folder, root=repo, lookups=lookups, license_text="CC0-1.0")

    assert files() == files_before
    assert 'Playlist "Baroque"' in output and "sorted by popularity" in output
    assert "Album: Johann Sebastian Bach" in output and "Album: Ludwig van Beethoven" in output
    assert "title from file name" in output and "composer from MusicBrainz (high)" in output
    assert "composition public domain: yes (Johann Sebastian Bach, died 1750)" in output
    assert "CC0-1.0" in output and "C major" in output and "120 BPM" in output
    assert 'track 1 "voz"' in output and "bars 0-8" in output and "4/4" in output
    assert "low confidence" in output  # my_own_tune: nothing confirmed it
    assert output.index("Ode to Joy") < output.index(
        "Air on the G String"
    )  # popularity 9000 > 5000


def test_preview_sorts_by_the_collections_default_sort(repo, lookups):
    folder = baroque(repo)
    init_collection(folder, root=repo, lookups=lookups, license_text="own-work")
    edit(folder, 'default_sort = "popularity"', 'default_sort = "title"')

    output = preview_collection(folder, root=repo, lookups=lookups)

    assert "sorted by title" in output
    assert output.index("Air on the G String") < output.index("Ode to Joy")


def test_preview_flags_songs_that_build_would_leave_out(repo, lookups):
    folder = baroque(repo)
    living_song(folder)

    output = preview_collection(folder, root=repo, lookups=lookups, license_text="public-domain")

    assert "NOT INCLUDED" in output and "--include-unconfirmed" in output
    assert "Living Person" in output


def test_preview_without_a_license_still_shows_everything_and_says_the_license_is_missing(
    repo, lookups
):
    folder = baroque(repo)

    output = preview_collection(folder, root=repo, lookups=lookups)

    assert "no license set" in output and "Ode to Joy" in output


# --- command line ---


def test_the_commands_work_from_the_command_line_offline(repo, capsys):
    folder = repo / "songs/pd"
    write_song(folder / "ode_to_joy.mid")
    root = ["--root", str(repo), "--offline"]

    assert main(["collection", "init", str(folder), "--license", "own-work", *root]) == 0
    assert main(["collection", "preview", str(folder), *root]) == 0
    assert "Ode to Joy" in capsys.readouterr().out
    assert main(["collection", "build", str(folder), *root]) == 0
    assert (repo / "arranger/data/catalog/pd.json").exists()
    assert main(["collection", "remove", "pd", "--root", str(repo)]) == 0
    assert not (repo / "arranger/data/catalog/pd.json").exists()
    assert (folder / "ode_to_joy.mid").exists() and (folder / "collection.toml").exists()


def test_the_command_line_reports_a_refusal_and_exits_with_1(repo, capsys):
    folder = repo / "songs/pd"
    write_song(folder / "ode.mid")

    code = main(["collection", "build", str(folder), "--root", str(repo), "--offline"])

    assert code == 1
    assert "license" in capsys.readouterr().err


def test_a_local_collection_is_listed_with_its_kind(repo, lookups, capsys):
    folder = baroque(repo)
    build_collection(folder, root=repo, lookups=lookups, license_text="own-work")

    assert main(["collection", "list", "--root", str(repo)]) == 0
    row = next(line for line in capsys.readouterr().out.splitlines() if line.startswith("baroque"))
    assert "local-midi" in row and " 2 " in row


def test_renaming_a_local_collection_also_changes_its_sidecar(repo, lookups):
    folder = baroque(repo)
    init_collection(folder, root=repo, lookups=lookups, license_text="own-work")
    build_collection(folder, root=repo, lookups=lookups)

    assert main(["collection", "rename", "baroque", "Old Masters", "--root", str(repo)]) == 0
    assert main(["collection", "order", "baroque", "5", "--root", str(repo)]) == 0

    collection, _ = read_sidecar(folder)
    assert (collection.name, collection.order) == ("Old Masters", 5)
    build_collection(folder, root=repo, lookups=lookups)  # a rebuild keeps both
    record = next(r for r in read_registry(repo) if r["id"] == "baroque")
    assert (record["name"], record["order"]) == ("Old Masters", 5)
