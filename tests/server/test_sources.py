"""The external search sources: URLs, parsers on synthetic answers, and file ids.

The fixtures in tests/server/fixtures/ are synthetic: they mirror the structure of each site's
answer (checked on 2026-10-20), with invented titles, people and paths.
"""

from pathlib import Path

import pytest

from server.sources import SearchResult, bitmidi, imslp, mutopia

FIXTURES = Path(__file__).with_name("fixtures")


def fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


# Mutopia


def test_mutopia_searches_its_listing_with_the_query_encoded():
    assert mutopia.search_url("Für Elise & co") == (
        "https://www.mutopiaproject.org/cgibin/make-table.cgi?searchingfor=F%C3%BCr+Elise+%26+co"
    )


def test_a_mutopia_result_has_title_composer_license_page_and_its_midi_file():
    results = mutopia.parse_search(fixture("mutopia-search.html"))
    assert results[0] == SearchResult(
        source="mutopia",
        id="ExampleA/test-waltz/test-waltz.mid",
        title="Test Waltz in C",
        composer="A. Example (1801–1870)",
        license="public-domain",
        format="midi",
        page="https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=9001",
        open="/files/mutopia/ExampleA/test-waltz/test-waltz.mid",
    )


def test_a_mutopia_piece_without_a_single_midi_file_links_to_its_page():
    suite = mutopia.parse_search(fixture("mutopia-search.html"))[1]
    assert suite.title == "Sample Suite"
    assert suite.format == "link"
    assert (
        suite.open == suite.page == "https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=9002"
    )
    assert suite.license == "CC-BY-4.0"


def test_mutopia_license_names_become_short_tags():
    polka = mutopia.parse_search(fixture("mutopia-search.html"))[2]
    assert (polka.title, polka.composer, polka.license) == (
        "Practice Polka",
        "Traditional",
        "CC-BY-SA-3.0",
    )
    assert mutopia.license_tag("Some Other License") == "Some Other License"


def test_a_mutopia_page_without_results_gives_no_results():
    assert mutopia.parse_search(b"<!DOCTYPE html><html><body>No matches</body></html>") == []


def test_a_mutopia_file_id_maps_only_to_a_midi_file_in_its_ftp_area():
    assert mutopia.file_url("ExampleA/test-waltz/test-waltz.mid") == (
        "https://www.mutopiaproject.org/ftp/ExampleA/test-waltz/test-waltz.mid"
    )


@pytest.mark.parametrize(
    "file_id",
    [
        "",
        "test-waltz.ly",
        "../secret.mid",
        "ExampleA/../../secret.mid",
        "/ExampleA/test.mid",
        "ExampleA//test.mid",
        "ExampleA/test.mid?x=1",
        "https://evil.example/test.mid",
        "ExampleA/te st.mid",
    ],
)
def test_other_mutopia_file_ids_are_refused(file_id):
    assert mutopia.file_url(file_id) is None


# BitMidi


def test_bitmidi_searches_its_api_for_30_results():
    assert bitmidi.search_url("test polka") == (
        "https://bitmidi.com/api/midi/search?q=test+polka&pageSize=30"
    )


def test_a_bitmidi_result_loads_through_its_download_url_with_an_unknown_license():
    results = bitmidi.parse_search(fixture("bitmidi-search.json"))
    assert results == [
        SearchResult(
            source="bitmidi",
            id="101",
            title="Test Polka",
            composer="",
            license="unknown",
            format="midi",
            page="https://bitmidi.com/test-polka-mid",
            open="/files/bitmidi/101",
        ),
        SearchResult(
            source="bitmidi",
            id="202",
            title="Another Example Tune",
            composer="",
            license="unknown",
            format="midi",
            page="https://bitmidi.com/another-example-tune",
            open="/files/bitmidi/202",
        ),
    ]


def test_a_bitmidi_answer_that_is_not_a_search_result_is_an_error():
    with pytest.raises(ValueError):
        bitmidi.parse_search(b'{"error": {"message": "boom", "code": null, "status": 500}}')


def test_a_bitmidi_file_id_is_a_number_on_its_uploads_area():
    assert bitmidi.file_url("101") == "https://bitmidi.com/uploads/101.mid"
    assert [bitmidi.file_url(bad) for bad in ("", "abc", "1/2", "-1", "1.mid", "١٢")] == [None] * 6


# IMSLP


def test_imslp_searches_work_pages_through_its_api():
    assert imslp.search_url("test waltz") == (
        "https://imslp.org/api.php?action=query&list=search&srsearch=test+waltz"
        "&srnamespace=0&srlimit=30&format=json"
    )


def test_an_imslp_result_only_links_to_the_work_page():
    results = imslp.parse_search(fixture("imslp-search.json"))
    page = "https://imslp.org/wiki/Test_Waltz,_Op.1_(Example,_Anna)"
    assert results[0] == SearchResult(
        source="imslp",
        id="Test Waltz, Op.1 (Example, Anna)",
        title="Test Waltz, Op.1",
        composer="Example, Anna",
        license="varies",
        format="link",
        page=page,
        open=page,
    )
    assert results[1].composer == "Exemplo, João"
    assert results[1].page == "https://imslp.org/wiki/Valse_in_A_minor_(Exemplo,_Jo%C3%A3o)"
    assert (results[2].title, results[2].composer) == ("Untitled Test Piece", "")


def test_an_imslp_answer_that_is_not_a_search_result_is_an_error():
    with pytest.raises(ValueError):
        imslp.parse_search(b'{"error": {"code": "nosrsearch", "info": "no query"}}')
