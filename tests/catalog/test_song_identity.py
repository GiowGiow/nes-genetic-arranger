"""Who wrote a MIDI file, and what is it called: guesses from the file, checked online.

A folder of MIDI files rarely says what each song is. `catalog.song_identity` reads the hints a
file carries (its name, and the text events inside it), turns them into a title and a composer,
and asks MusicBrainz whether such a work exists. These tests use fake fetchers shaped like
MusicBrainz's JSON answers: no network.
"""

import json
from pathlib import Path

import mido
import pytest

from catalog.song_identity import (
    Identity,
    MidiHints,
    fetch_musicbrainz,
    identify_song,
    is_generic_title,
    midi_hints,
    musicbrainz_url,
    name_guesses,
    normalize_person,
    search_works,
)

# --- The file name ---


def guess_pairs(stem: str) -> list[tuple[str, str]]:
    return [(guess.title, guess.composer) for guess in name_guesses(stem)]


def test_a_composer_dash_title_name_gives_both_and_a_title_dash_composer_name_too():
    assert guess_pairs("Bach - Air on the G String")[0] == ("Air on the G String", "Bach")
    assert guess_pairs("Air on the G String - Bach")[0] == ("Air on the G String", "Bach")
    assert guess_pairs("Chopin – Nocturne Op. 9 No. 2")[0] == ("Nocturne Op. 9 No. 2", "Chopin")


def test_when_neither_side_looks_like_a_composer_it_is_composer_dash_title_first():
    pairs = guess_pairs("Fulano de Tal - Valsa da Esquina")
    assert pairs == [("Valsa da Esquina", "Fulano de Tal"), ("Fulano de Tal", "Valsa da Esquina")]


def test_underscores_and_dashes_without_spaces_are_word_separators_not_field_separators():
    assert guess_pairs("minuet_in_g") == [("Minuet in G", "")]
    assert guess_pairs("Gymnopedie-No-1") == [("Gymnopedie No 1", "")]


def test_a_composer_at_either_end_of_an_underscored_name_is_found():
    assert guess_pairs("air_on_the_g_string_bach")[0] == ("Air on the G String", "Bach")
    assert guess_pairs("mozart_eine_kleine_nachtmusik")[0] == ("Eine Kleine Nachtmusik", "Mozart")
    assert guess_pairs("villa_lobos_bachianas_no_5")[0] == ("Bachianas No 5", "Villa Lobos")


def test_a_double_underscore_or_by_separates_title_and_composer():
    assert guess_pairs("clair_de_lune__debussy")[0] == ("Clair de Lune", "Debussy")
    assert guess_pairs("Prelude in C by J S Bach")[0] == ("Prelude in C", "J S Bach")


def test_catalog_numbers_stay_in_the_title():
    assert guess_pairs("bach_toccata_and_fugue_bwv_565")[0] == (
        "Toccata and Fugue BWV 565",
        "Bach",
    )
    assert guess_pairs("Moonlight Sonata Op 27 No 2 - Beethoven")[0][0] == (
        "Moonlight Sonata Op 27 No 2"
    )


def test_a_leading_track_number_and_a_copy_marker_are_dropped():
    assert guess_pairs("01 - Beethoven - Fur Elise")[0] == ("Fur Elise", "Beethoven")
    assert guess_pairs("03_ode_to_joy (1)")[0] == ("Ode to Joy", "")


def test_a_title_in_capitals_or_in_lower_case_is_written_in_title_case_and_mixed_case_is_kept():
    assert guess_pairs("AIR ON THE G STRING")[0][0] == "Air on the G String"
    assert guess_pairs("GymnopÉdie")[0][0] == "GymnopÉdie"


@pytest.mark.parametrize(
    "stem", ["track01", "Track 1", "untitled", "song", "01", "midi", "New Song", "Sequence 2"]
)
def test_a_name_that_says_nothing_is_generic(stem):
    assert is_generic_title(stem)


def test_a_name_with_words_is_not_generic():
    assert not is_generic_title("Ode to Joy")
    assert not is_generic_title("track of my heart")


def test_composer_names_are_normalized_from_surname_first_and_initials():
    assert normalize_person("Bach, Johann Sebastian") == "Johann Sebastian Bach"
    assert normalize_person("  j.s.  bach ") == "J S Bach"
    assert normalize_person("Chopin") == "Chopin"


# --- The hints inside the file ---


def write_midi_with_text(path: Path, events: list[tuple[str, str]]) -> Path:
    """A MIDI file whose first track holds the given meta events (type, text)."""
    midi = mido.MidiFile(type=1, ticks_per_beat=480)
    conductor = mido.MidiTrack()
    for kind, text in events:
        conductor.append(
            mido.MetaMessage(kind, **{"name" if kind == "track_name" else "text": text})
        )
    conductor.append(mido.MetaMessage("set_tempo", tempo=500000))
    conductor.append(mido.MetaMessage("end_of_track"))
    notes = mido.MidiTrack()
    notes.append(mido.Message("note_on", note=60, velocity=80, time=0))
    notes.append(mido.Message("note_off", note=60, velocity=0, time=480))
    midi.tracks += [conductor, notes]
    midi.save(str(path))
    return path


def test_the_first_tracks_name_and_the_labeled_text_events_are_hints(tmp_path):
    path = write_midi_with_text(
        tmp_path / "a.mid",
        [
            ("track_name", "Gymnopedie No. 1"),
            ("text", "Composer: Erik Satie"),
            ("copyright", "(c) 1999 Some Sequencer"),
        ],
    )

    hints = midi_hints(path)

    assert hints.sequence_name == "Gymnopedie No. 1"
    assert hints.composer == "Erik Satie"
    assert hints.copyright == "(c) 1999 Some Sequencer"


def test_composed_by_music_by_and_compositor_label_a_composer_too(tmp_path):
    for label, text in (
        ("composed by", "Composed by Claude Debussy"),
        ("music by", "Music by: Claude Debussy"),
        ("compositor", "Compositor: Claude Debussy"),
    ):
        path = write_midi_with_text(tmp_path / f"{label}.mid", [("text", text)])
        assert midi_hints(path).composer == "Claude Debussy", label


def test_karaoke_style_title_events_give_a_title(tmp_path):
    path = write_midi_with_text(tmp_path / "k.mid", [("text", "@TClair de Lune")])
    assert midi_hints(path).title == "Clair de Lune"
    path = write_midi_with_text(tmp_path / "t.mid", [("text", "Title: Clair de Lune")])
    assert midi_hints(path).title == "Clair de Lune"


def test_a_file_with_no_hints_or_that_is_not_midi_gives_empty_hints(tmp_path):
    plain = write_midi_with_text(tmp_path / "plain.mid", [])
    broken = tmp_path / "broken.mid"
    broken.write_bytes(b"MThd\x00\x00")

    assert midi_hints(plain) == MidiHints()
    assert midi_hints(broken) == MidiHints()


# --- MusicBrainz ---


def work(
    title: str, composers: tuple[str, ...] = (), score: int = 100, work_id: str = "w1"
) -> dict:
    relations = [{"type": "composer", "artist": {"name": name}} for name in composers]
    return {"id": work_id, "score": score, "title": title, "relations": relations}


class FakeMusicBrainz:
    """Answers MusicBrainz work searches from a table keyed by the query's work title."""

    def __init__(self, table: dict[str, list[dict]] | None = None, fail: bool = False):
        self.table = table or {}
        self.fail = fail
        self.urls: list[str] = []

    def __call__(self, url: str) -> dict:
        self.urls.append(url)
        if self.fail:
            raise OSError("no network")
        from urllib.parse import parse_qs, urlparse

        query = parse_qs(urlparse(url).query)["query"][0]
        title = query.split('"')[1]
        return {"works": self.table.get(title, [])}


def no_sleep(seconds: float) -> None:
    sleeps.append(seconds)


sleeps: list[float] = []


def test_the_search_url_asks_for_json_work_matches_by_title_and_composer():
    url = musicbrainz_url("Air on the G String", "Bach")

    assert url.startswith("https://musicbrainz.org/ws/2/work/?")
    assert "fmt=json" in url and "limit=" in url
    assert "work%3A%22Air+on+the+G+String%22" in url or "work:%22Air" in url
    assert "Bach" in url
    assert "artist" not in musicbrainz_url("Air", "")


def test_a_quote_in_a_title_cannot_break_the_query():
    assert '\\"' in __import__("urllib.parse").parse.unquote_plus(musicbrainz_url('Say "hi"', ""))


def test_works_come_back_with_their_composers_from_the_relations(tmp_path):
    fake = FakeMusicBrainz({"Air": [work("Air", ("Johann Sebastian Bach",), 100, "abc")]})

    works = search_works("Air", "Bach", tmp_path, fake, no_sleep)

    assert works[0].title == "Air"
    assert works[0].composers == ("Johann Sebastian Bach",)
    assert works[0].score == 100
    assert works[0].url == "https://musicbrainz.org/work/abc"


def test_every_answer_is_cached_so_a_rerun_asks_nothing_and_waits_for_nothing(tmp_path):
    fake = FakeMusicBrainz({"Air": [work("Air", ("Johann Sebastian Bach",))]})
    sleeps.clear()
    search_works("Air", "Bach", tmp_path, fake, no_sleep)
    assert len(fake.urls) == 1 and sleeps == [1.0]  # polite: one request a second

    sleeps.clear()
    search_works("Air", "Bach", tmp_path, fake, no_sleep)
    assert len(fake.urls) == 1 and sleeps == []


def test_a_search_with_a_delay_under_a_second_is_refused(tmp_path):
    with pytest.raises(ValueError, match="1.0"):
        search_works("Air", "Bach", tmp_path, FakeMusicBrainz(), no_sleep, delay=0.2)


def test_a_work_without_relations_has_no_composers(tmp_path):
    fake = FakeMusicBrainz({"Air": [{"id": "x", "score": 90, "title": "Air"}]})
    assert search_works("Air", "", tmp_path, fake, no_sleep)[0].composers == ()


# --- Putting it together ---


def identify(path: Path, tmp_path: Path, table=None, fail=False) -> Identity:
    return identify_song(path, tmp_path / "cache", FakeMusicBrainz(table, fail), no_sleep)


def test_a_title_and_composer_in_the_file_name_that_musicbrainz_confirms_are_high_confidence(
    tmp_path,
):
    path = write_midi_with_text(tmp_path / "Bach - Air on the G String.mid", [])
    table = {
        "Air on the G String": [work("Air on the G String", ("Johann Sebastian Bach",), 100, "w9")]
    }

    found = identify(path, tmp_path, table)

    assert found.title == "Air on the G String"
    assert found.composer == "Johann Sebastian Bach"  # the full name MusicBrainz gives
    assert found.confidence == "high"
    assert found.title_from == "file name"
    assert found.composer_from == "MusicBrainz"
    assert found.musicbrainz == "https://musicbrainz.org/work/w9"


def test_a_composer_the_name_does_not_give_is_filled_in_by_musicbrainz_with_medium_confidence(
    tmp_path,
):
    path = write_midi_with_text(tmp_path / "ode_to_joy.mid", [])
    table = {"Ode to Joy": [work("Ode to Joy", ("Ludwig van Beethoven",), 98)]}

    found = identify(path, tmp_path, table)

    assert (found.title, found.composer) == ("Ode to Joy", "Ludwig van Beethoven")
    assert found.confidence == "medium"
    assert found.composer_from == "MusicBrainz"


def test_a_work_whose_composer_is_someone_else_is_not_taken(tmp_path):
    path = write_midi_with_text(tmp_path / "Bach - Ode to Joy.mid", [])
    table = {"Ode to Joy": [work("Ode to Joy", ("Ludwig van Beethoven",), 100)]}

    found = identify(path, tmp_path, table)

    assert found.composer == "Bach"  # kept as the file says
    assert found.confidence == "low"
    assert found.composer_from == "file name"
    assert found.musicbrainz == ""


def test_a_title_musicbrainz_does_not_know_stays_as_the_file_says_with_low_confidence(tmp_path):
    path = write_midi_with_text(tmp_path / "my_own_tune.mid", [])

    found = identify(path, tmp_path, {})

    assert (found.title, found.composer) == ("My Own Tune", "")
    assert found.confidence == "low"
    assert found.musicbrainz == ""


def test_the_other_order_of_a_dashed_name_is_tried_when_the_first_finds_nothing(tmp_path):
    path = write_midi_with_text(tmp_path / "Valsa da Esquina - Fulano de Tal.mid", [])
    fake = FakeMusicBrainz({"Valsa da Esquina": [work("Valsa da Esquina", ("Fulano de Tal",))]})

    found = identify_song(path, tmp_path / "cache", fake, no_sleep)

    # First guess: composer "Valsa da Esquina", title "Fulano de Tal" (nothing). Second works.
    assert (found.title, found.composer) == ("Valsa da Esquina", "Fulano de Tal")
    assert found.confidence == "high"
    assert len(fake.urls) == 2


def test_a_generic_file_name_takes_the_title_from_the_sequence_name_in_the_file(tmp_path):
    path = write_midi_with_text(
        tmp_path / "track01.mid",
        [("track_name", "Gymnopedie No 1"), ("text", "Composer: Erik Satie")],
    )

    found = identify(path, tmp_path, {})

    assert (found.title, found.composer) == ("Gymnopedie No 1", "Erik Satie")
    assert found.title_from == "MIDI sequence name"
    assert found.composer_from == "MIDI text event"


def test_a_composer_in_the_file_fills_what_the_name_lacks(tmp_path):
    path = write_midi_with_text(
        tmp_path / "gymnopedie_no_1.mid", [("text", "Composer: Erik Satie")]
    )

    found = identify(path, tmp_path, {})

    assert found.composer == "Erik Satie" and found.composer_from == "MIDI text event"


def test_without_a_network_the_guess_stands_and_says_the_lookup_failed(tmp_path):
    path = write_midi_with_text(tmp_path / "Bach - Air.mid", [])

    found = identify(path, tmp_path, fail=True)

    assert (found.title, found.composer) == ("Air", "Bach")
    assert found.confidence == "low"
    assert "could not be reached" in found.note


def test_a_file_with_nothing_to_go_on_is_named_after_its_file_with_low_confidence(tmp_path):
    path = write_midi_with_text(tmp_path / "track01.mid", [])

    found = identify(path, tmp_path, {})

    assert found.title == "Track01"
    assert found.confidence == "low"


def test_the_identity_can_be_written_as_json(tmp_path):
    path = write_midi_with_text(tmp_path / "ode.mid", [])
    found = identify(path, tmp_path, {})
    assert json.loads(json.dumps(found.__dict__))["title"] == "Ode"


# --- The composer MusicBrainz gives ---


def test_only_the_composer_the_name_points_to_is_taken_when_a_work_lists_several(tmp_path):
    path = write_midi_with_text(tmp_path / "Beethoven - Ode to Joy.mid", [])
    table = {
        "Ode to Joy": [
            work("Ode to Joy", ("Ludwig van Beethoven", "Giscard Rasquin"), 100),
        ]
    }

    found = identify(path, tmp_path, table)

    assert found.composer == "Ludwig van Beethoven"
    assert found.confidence == "high"


def test_without_a_composer_in_the_name_the_one_most_works_agree_on_is_taken(tmp_path):
    path = write_midi_with_text(tmp_path / "ode_to_joy.mid", [])
    table = {
        "Ode to Joy": [
            work("Ode to Joy", ("Ludwig van Beethoven", "Giscard Rasquin"), 100, "a"),
            work("Ode to Joy", ("Ludwig van Beethoven",), 98, "b"),
            work("Ode to Joy", ("Someone Else",), 95, "c"),
        ]
    }

    found = identify(path, tmp_path, table)

    assert found.composer == "Ludwig van Beethoven"
    assert found.confidence == "medium"


# --- A service that is busy ---


class BusyThenFine:
    """An opener that answers 503 a few times, then a JSON body."""

    def __init__(self, failures: int):
        self.failures = failures
        self.calls = 0

    def __call__(self, request, timeout):
        import io
        import urllib.error

        self.calls += 1
        if self.calls <= self.failures:
            raise urllib.error.HTTPError(request.full_url, 503, "busy", {}, io.BytesIO(b""))

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        return Response(b'{"works": []}')


def test_a_busy_service_is_asked_again_after_a_pause(tmp_path):
    opener, pauses = BusyThenFine(failures=2), []

    answer = fetch_musicbrainz("https://musicbrainz.org/ws/2/work/?query=x", opener, pauses.append)

    assert answer == {"works": []}
    assert opener.calls == 3 and len(pauses) == 2 and all(p >= 1.0 for p in pauses)


def test_a_service_that_stays_busy_gives_up_with_the_error(tmp_path):
    opener = BusyThenFine(failures=99)
    with pytest.raises(OSError, match="503"):
        fetch_musicbrainz("https://musicbrainz.org/ws/2/work/?query=x", opener, lambda s: None)
    assert opener.calls == 4
