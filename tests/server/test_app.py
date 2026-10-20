"""The song server's HTTP routes, CORS, rate limits and privacy, against a fake internet."""

import hashlib
import json
import logging
from dataclasses import replace
from pathlib import Path

import pytest
from starlette.testclient import TestClient

import main
from config import load_config
from leadsheet.abc_writer import lead_sheet_to_abc
from server.app import UVICORN_OPTIONS, create_app
from server.fetcher import MAX_BYTES
from server.sources import bitmidi, imslp, mutopia

FIXTURES = Path(__file__).resolve().parents[2] / "arranger" / "tests" / "fixtures" / "midi-songs"
SEARCH_FIXTURES = Path(__file__).with_name("fixtures")
MIDI = (FIXTURES / "synthetic-waltz.mid").read_bytes()
PAGES_ORIGIN = "https://giowgiow.github.io"


def mpb_entry(song: str, song_id: str | None = None, **facts) -> dict:
    """A catalog entry for a committed synthetic MIDI fixture, served at a fake MPB URL."""
    song_id = song_id or song
    midi = (FIXTURES / f"{song}.mid").read_bytes()
    entry = {
        "id": song_id,
        "source": "mpb",
        "t": f"Test song {song}",
        "c": "Ana Teste e Bruno Exemplo",
        "p": "Banda Sintética",
        "u": f"https://www.beakauffmann.com/mpb_s/{song_id}.html",
        "license": "all-rights-reserved",
        "seed": 12345,
        "route": {"server": f"/songs/mpb/{song_id}.abc"},
        "facts": {
            "midi": f"https://www.beakauffmann.com/mpb_s/som/{song}.mid",
            "sha256": hashlib.sha256(midi).hexdigest(),
            "melody_track": 0,
            "bars": [0, 6],
            "sections": [[0, "A"]],
            "key": "",
            "tempo_bpm": 120.0,
            "meter": "4/4",
            "n_bars": 6,
            "drums": True,
            "overrides": {"max_generations": 4000, "stagnation_window": 400},
        },
    }
    entry["facts"].update(facts)
    return entry


def serve_fixture(internet, song: str) -> None:
    internet.add(
        f"https://www.beakauffmann.com/mpb_s/som/{song}.mid",
        (FIXTURES / f"{song}.mid").read_bytes(),
    )


@pytest.fixture
def make_client(tmp_path, make_fetcher, clock):
    """Build a TestClient for an app with the given MPB entries and denylist."""

    def build(entries=(), denylist=None, version="test-commit") -> TestClient:
        catalog_dir = tmp_path / "catalog"
        catalog_dir.mkdir(exist_ok=True)
        envelope = {"source": "mpb", "name": "MPB", "entries": list(entries)}
        (catalog_dir / "mpb.json").write_text(json.dumps(envelope), encoding="utf-8")
        app = create_app(
            catalog_dir=catalog_dir,
            fetcher=make_fetcher(),
            denylist=denylist or {},
            version=version,
            clock=clock,
        )
        return TestClient(app)

    return build


def without_comments(abc: str) -> list[str]:
    return [line for line in abc.splitlines() if not line.startswith("%")]


# /health


def test_health_says_ok_with_the_deployed_commit(make_client):
    response = make_client(version="0123abc").get("/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "version": "0123abc"}
    assert response.headers["cache-control"] == "no-store"


def test_the_version_comes_from_the_environment_or_is_dev(tmp_path, make_fetcher, monkeypatch):
    monkeypatch.setenv("APP_COMMIT", "fedcba9")
    app = create_app(catalog_dir=tmp_path, fetcher=make_fetcher(), denylist={})
    assert TestClient(app).get("/health").json()["version"] == "fedcba9"
    monkeypatch.delenv("APP_COMMIT")
    app = create_app(catalog_dir=tmp_path, fetcher=make_fetcher(), denylist={})
    assert TestClient(app).get("/health").json()["version"] == "dev"


# /songs/mpb/<id>.abc


@pytest.mark.parametrize(
    ("song", "bars", "sections"),
    [
        ("synthetic-changes", [0, 6], [[0, "A"], [4, "B"]]),
        ("synthetic-waltz", [2, 8], [[0, "A"]]),
    ],
)
def test_an_mpb_song_is_the_abc_lead_sheet_the_command_line_reduces(
    make_client, internet, song, bars, sections
):
    serve_fixture(internet, song)
    entry = mpb_entry(song, bars=bars, sections=sections)
    response = make_client([entry]).get(f"/songs/mpb/{song}.abc")
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/plain; charset=utf-8"
    assert response.headers["x-source-page"] == entry["u"]

    # The command line, given the same file and the recorded options as --set overrides.
    config = load_config(
        overrides=[
            "midi.melody_track=0",
            f"midi.bars={json.dumps(bars)}",
            f"midi.sections={json.dumps(sections)}",
        ]
    )
    lead_sheet = main.load_lead_sheet(FIXTURES / f"{song}.mid", config)
    expected = lead_sheet_to_abc(replace(lead_sheet, title=entry["t"]), config["phrase_length"])
    assert without_comments(response.text) == without_comments(expected)


def test_the_lead_sheet_credits_its_source_and_says_it_is_not_stored(make_client, internet):
    serve_fixture(internet, "synthetic-changes")
    entry = mpb_entry("synthetic-changes")
    text = make_client([entry]).get("/songs/mpb/synthetic-changes.abc").text
    header = "\n".join(line for line in text.splitlines() if line.startswith("%"))
    assert entry["u"] in header
    assert entry["facts"]["midi"] in header
    assert "Ana Teste e Bruno Exemplo" in header
    assert "All Rights Reserved" in header
    assert entry["facts"]["sha256"] in header


def test_an_unknown_mpb_song_is_not_found(make_client, internet):
    response = make_client([mpb_entry("synthetic-changes")]).get("/songs/mpb/nope.abc")
    assert response.status_code == 404
    assert set(response.json()) == {"error"}
    assert internet.requests == []


def test_a_denylisted_mpb_song_is_not_found_and_its_source_is_not_contacted(make_client, internet):
    serve_fixture(internet, "synthetic-changes")
    client = make_client([mpb_entry("synthetic-changes")], denylist={"mpb": ["synthetic-changes"]})
    response = client.get("/songs/mpb/synthetic-changes.abc")
    assert response.status_code == 404
    assert internet.requests == []


def test_a_source_file_that_changed_since_the_analysis_is_refused(make_client, internet):
    internet.add(
        "https://www.beakauffmann.com/mpb_s/som/synthetic-changes.mid",
        (FIXTURES / "synthetic-waltz.mid").read_bytes(),
    )
    response = make_client([mpb_entry("synthetic-changes")]).get("/songs/mpb/synthetic-changes.abc")
    assert response.status_code == 409
    assert "changed" in response.json()["error"]


def test_a_song_the_reader_cannot_reduce_is_unprocessable(make_client, internet):
    serve_fixture(internet, "synthetic-changes")
    entry = mpb_entry("synthetic-changes", melody_track=3)  # track 3 is the drum track
    response = make_client([entry]).get("/songs/mpb/synthetic-changes.abc")
    assert response.status_code == 422
    assert set(response.json()) == {"error"}


def test_a_catalog_entry_marked_unarrangeable_is_unprocessable_without_a_download(
    make_client, internet
):
    entry = mpb_entry("synthetic-changes")
    del entry["route"]
    entry["error"] = "no melodic track"
    response = make_client([entry]).get("/songs/mpb/synthetic-changes.abc")
    assert response.status_code == 422
    assert internet.requests == []


def test_an_unreachable_source_is_a_bad_gateway(make_client, internet):
    internet.add("https://www.beakauffmann.com/mpb_s/som/synthetic-changes.mid", status=503)
    response = make_client([mpb_entry("synthetic-changes")]).get("/songs/mpb/synthetic-changes.abc")
    assert response.status_code == 502
    assert response.headers["cache-control"] == "no-store"


def test_a_source_that_sends_a_web_page_instead_of_midi_is_a_bad_gateway(make_client, internet):
    internet.add(
        "https://www.beakauffmann.com/mpb_s/som/synthetic-changes.mid",
        b"<!DOCTYPE html><html>Page not found</html>",
    )
    response = make_client([mpb_entry("synthetic-changes")]).get("/songs/mpb/synthetic-changes.abc")
    assert response.status_code == 502


def test_a_missing_catalog_file_leaves_the_mpb_route_empty(tmp_path, make_fetcher):
    app = create_app(catalog_dir=tmp_path / "absent", fetcher=make_fetcher(), denylist={})
    assert TestClient(app).get("/songs/mpb/anything.abc").status_code == 404


# Errors and methods


def test_unknown_routes_and_other_methods_answer_with_a_json_error(make_client):
    client = make_client()
    missing = client.get("/nothing/here")
    assert missing.status_code == 404
    assert set(missing.json()) == {"error"}
    posted = client.post("/health")
    assert posted.status_code == 405
    assert set(posted.json()) == {"error"}


# CORS


@pytest.mark.parametrize(
    "origin",
    [PAGES_ORIGIN, "http://localhost:8000", "http://localhost", "http://127.0.0.1:5500"],
)
def test_cors_allows_the_pages_site_and_localhost(make_client, origin):
    response = make_client().get("/health", headers={"Origin": origin})
    assert response.headers["access-control-allow-origin"] == origin
    assert "access-control-allow-credentials" not in response.headers
    exposed = response.headers["access-control-expose-headers"].lower()
    assert "x-source-page" in exposed
    assert "retry-after" in exposed


@pytest.mark.parametrize(
    "origin",
    [
        "https://evil.example",
        "http://localhost.evil.example",
        "https://giowgiow.github.io.evil.example",
        "http://giowgiow.github.io",
        "https://localhost:8000",
        "http://10.0.0.5:8000",
    ],
)
def test_cors_gives_other_origins_nothing(make_client, origin):
    response = make_client().get("/health", headers={"Origin": origin})
    assert "access-control-allow-origin" not in response.headers


def test_a_preflight_allows_get_only(make_client):
    client = make_client()
    ok = client.options(
        "/search", headers={"Origin": PAGES_ORIGIN, "Access-Control-Request-Method": "GET"}
    )
    assert ok.status_code == 200
    assert ok.headers["access-control-allow-methods"] == "GET"
    refused = client.options(
        "/search", headers={"Origin": PAGES_ORIGIN, "Access-Control-Request-Method": "POST"}
    )
    assert refused.status_code == 400


# Rate limits


def test_a_visitor_over_60_requests_a_minute_is_told_to_retry_later(make_client, clock):
    client = make_client()
    visitor = {"X-Forwarded-For": "198.51.100.7, 10.42.0.1", "Origin": PAGES_ORIGIN}
    statuses = [client.get("/songs/mpb/x.abc", headers=visitor).status_code for _ in range(60)]
    assert statuses == [404] * 60
    limited = client.get("/songs/mpb/x.abc", headers=visitor)
    assert limited.status_code == 429
    assert int(limited.headers["retry-after"]) >= 1
    assert set(limited.json()) == {"error"}
    # The page can read the 429 and its Retry-After.
    assert limited.headers["access-control-allow-origin"] == PAGES_ORIGIN

    # Another visitor is not affected; the same visitor behind another proxy hop is.
    other = {"X-Forwarded-For": "198.51.100.8"}
    assert client.get("/songs/mpb/x.abc", headers=other).status_code == 404
    same = {"X-Forwarded-For": "198.51.100.7, 10.42.0.2"}
    assert client.get("/songs/mpb/x.abc", headers=same).status_code == 429

    clock.now += 60
    assert client.get("/songs/mpb/x.abc", headers=visitor).status_code == 404


def test_health_checks_are_not_rate_limited(make_client):
    client = make_client()
    assert {client.get("/health").status_code for _ in range(100)} == {200}


# Privacy


def test_the_server_logs_no_visitor_address_or_query(make_client, internet, caplog):
    internet.add("https://www.beakauffmann.com/mpb_s/som/synthetic-changes.mid", status=500)
    client = make_client([mpb_entry("synthetic-changes")])
    visitor = {"X-Forwarded-For": "198.51.100.77"}
    with caplog.at_level(logging.DEBUG):
        for _ in range(65):
            client.get("/songs/mpb/synthetic-changes.abc?secretquery=1", headers=visitor)
            client.get("/health?secretquery=2", headers=visitor)
    assert "198.51.100.77" not in caplog.text
    assert "secretquery" not in caplog.text
    assert "testclient" not in caplog.text


def test_uvicorn_serves_on_localhost_port_8765_without_an_access_log():
    assert UVICORN_OPTIONS == {"host": "127.0.0.1", "port": 8765, "access_log": False}


# /search


def serve_searches(internet, query: str, bitmidi_answer: bytes | None = None) -> None:
    """Answer `query` on the three sites with the synthetic fixtures."""
    internet.add(mutopia.search_url(query), (SEARCH_FIXTURES / "mutopia-search.html").read_bytes())
    internet.add(
        bitmidi.search_url(query),
        bitmidi_answer or (SEARCH_FIXTURES / "bitmidi-search.json").read_bytes(),
    )
    internet.add(imslp.search_url(query), (SEARCH_FIXTURES / "imslp-search.json").read_bytes())


@pytest.mark.parametrize("query", [None, "", "a", "  a  "])
def test_a_search_shorter_than_two_characters_is_a_bad_request(make_client, internet, query):
    params = {} if query is None else {"q": query}
    response = make_client().get("/search", params=params)
    assert response.status_code == 400
    assert set(response.json()) == {"error"}
    assert internet.requests == []


def test_a_search_longer_than_100_characters_is_a_bad_request(make_client, internet):
    assert make_client().get("/search", params={"q": "x" * 101}).status_code == 400
    assert internet.requests == []


def test_a_search_gathers_every_site_and_says_how_each_one_answered(make_client, internet):
    serve_searches(internet, "waltz")
    response = make_client().get("/search", params={"q": "waltz"})
    assert response.status_code == 200
    assert response.headers["cache-control"].startswith("private")
    answer = response.json()
    assert answer["sources"] == {"mutopia": "ok", "bitmidi": "ok", "imslp": "ok"}
    assert [r["source"] for r in answer["results"]] == ["mutopia"] * 3 + ["bitmidi"] * 2 + [
        "imslp"
    ] * 3
    fields = {"source", "id", "title", "composer", "license", "format", "page", "open"}
    assert all(set(result) == fields for result in answer["results"])
    assert answer["results"][0]["open"] == "/files/mutopia/ExampleA/test-waltz/test-waltz.mid"


def test_a_site_that_fails_is_marked_error_while_the_others_still_answer(make_client, internet):
    serve_searches(internet, "waltz")
    internet.add(bitmidi.search_url("waltz"), b"busy", status=503)
    answer = make_client().get("/search", params={"q": "waltz"}).json()
    assert answer["sources"] == {"mutopia": "ok", "bitmidi": "error", "imslp": "ok"}
    assert {r["source"] for r in answer["results"]} == {"mutopia", "imslp"}


def test_a_site_answering_something_else_than_results_is_marked_error(make_client, internet):
    serve_searches(internet, "waltz", bitmidi_answer=b'{"error": {"message": "boom"}}')
    answer = make_client().get("/search", params={"q": "waltz"}).json()
    assert answer["sources"]["bitmidi"] == "error"


def test_each_site_gives_at_most_30_results(make_client, internet):
    hits = [
        {"id": n, "name": f"Tune {n}", "url": f"/tune-{n}", "downloadUrl": f"/uploads/{n}.mid"}
        for n in range(1, 46)
    ]
    serve_searches(
        internet, "tune", bitmidi_answer=json.dumps({"result": {"results": hits}}).encode()
    )
    answer = make_client().get("/search", params={"q": "tune"}).json()
    assert sum(r["source"] == "bitmidi" for r in answer["results"]) == 30


def test_denylisted_files_are_left_out_of_search_results(make_client, internet):
    serve_searches(internet, "waltz")
    client = make_client(
        denylist={"mutopia": ["ExampleA/test-waltz/test-waltz.mid"], "bitmidi": ["101"]}
    )
    ids = {r["id"] for r in client.get("/search", params={"q": "waltz"}).json()["results"]}
    assert "ExampleA/test-waltz/test-waltz.mid" not in ids
    assert "101" not in ids
    assert "202" in ids


def test_a_visitor_may_search_20_times_a_minute(make_client, internet):
    serve_searches(internet, "waltz")
    client = make_client()
    statuses = [client.get("/search", params={"q": "waltz"}).status_code for _ in range(21)]
    assert statuses == [200] * 20 + [429]
    assert client.get("/songs/mpb/x.abc").status_code == 404  # other requests still pass


def test_the_query_reaches_the_sites_but_never_the_log(make_client, internet, caplog):
    serve_searches(internet, "secretwaltz")
    internet.add(bitmidi.search_url("secretwaltz"), b"busy", status=503)
    with caplog.at_level(logging.DEBUG):
        make_client().get(
            "/search", params={"q": "secretwaltz"}, headers={"X-Forwarded-For": "198.51.100.9"}
        )
    assert any("secretwaltz" in url for url in internet.urls())
    assert "secretwaltz" not in caplog.text
    assert "198.51.100.9" not in caplog.text


# /files/<source>/<id>


def test_a_mutopia_file_is_served_as_midi(make_client, internet):
    internet.add("https://www.mutopiaproject.org/ftp/ExampleA/test-waltz/test-waltz.mid", MIDI)
    response = make_client().get("/files/mutopia/ExampleA/test-waltz/test-waltz.mid")
    assert response.status_code == 200
    assert response.content == MIDI
    assert response.headers["content-type"] == "audio/midi"
    assert response.headers["cache-control"].startswith("private")


def test_a_bitmidi_file_is_served_as_midi(make_client, internet):
    internet.add("https://bitmidi.com/uploads/101.mid", MIDI)
    response = make_client().get("/files/bitmidi/101")
    assert response.status_code == 200
    assert response.content == MIDI
    assert response.headers["content-type"] == "audio/midi"


def test_a_file_that_holds_an_abc_tune_is_served_as_text(make_client, internet):
    internet.add("https://bitmidi.com/uploads/7.mid", b"X:1\nT:Tune\nK:C\nCDEF|\n")
    response = make_client().get("/files/bitmidi/7")
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/plain; charset=utf-8"


def test_a_file_over_two_megabytes_is_too_large(make_client, internet):
    internet.add("https://bitmidi.com/uploads/8.mid", b"MThd" + b"\x00" * MAX_BYTES)
    response = make_client().get("/files/bitmidi/8")
    assert response.status_code == 413
    assert set(response.json()) == {"error"}


def test_a_file_that_is_neither_midi_nor_abc_is_refused(make_client, internet):
    internet.add("https://bitmidi.com/uploads/9.mid", b"<!DOCTYPE html><html>Sign in</html>")
    assert make_client().get("/files/bitmidi/9").status_code == 415


def test_a_file_the_site_does_not_send_is_a_bad_gateway(make_client, internet):
    internet.add("https://bitmidi.com/uploads/10.mid", b"oops", status=500)
    assert make_client().get("/files/bitmidi/10").status_code == 502


@pytest.mark.parametrize(
    "path",
    [
        "/files/imslp/Test_Waltz",  # IMSLP results are links only
        "/files/thesession/1",  # The Session is the browser's, never the server's
        "/files/elsewhere/1",
        "/files/mutopia/ExampleA/test-waltz/test-waltz.ly",
        "/files/bitmidi/abc",
    ],
)
def test_unknown_sources_and_ids_are_not_found_without_contacting_any_site(
    make_client, internet, path
):
    response = make_client().get(path)
    assert response.status_code == 404
    assert set(response.json()) == {"error"}
    assert internet.requests == []


def test_a_denylisted_file_is_not_served(make_client, internet):
    internet.add("https://bitmidi.com/uploads/101.mid", MIDI)
    response = make_client(denylist={"bitmidi": ["101"]}).get("/files/bitmidi/101")
    assert response.status_code == 404
    assert internet.requests == []
