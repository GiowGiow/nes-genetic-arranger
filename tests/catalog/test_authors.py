"""Authors' death years from Wikidata, and the public-domain rule (research R11).

A song's lead sheet may be committed when every listed author died 70 or more full years ago
(Lei 9.610/98 art. 41: in 2026, a death in 1955 or earlier). An author with no match, or with
matches that disagree, is "unknown" and keeps the song out. These tests never touch the network:
a fake SPARQL endpoint answers with responses shaped like Wikidata's JSON results.
"""

import argparse
import json

import pytest

from catalog.authors import (
    BATCH_SIZE,
    AuthorRecord,
    is_public_domain,
    public_domain_limit,
    read_authors,
    resolve_names,
    song_is_public_domain,
    sparql_query,
    split_composers,
    write_authors,
)
from catalog.crawl import add_catalog_parser

ENTITY = "http://www.wikidata.org/entity/"
MUSICIAN, COMPOSER, FOOTBALLER = "Q639669", "Q36834", "Q937857"


# --- Splitting composer strings ---


def test_composer_strings_split_on_commas_and_the_portuguese_and():
    assert split_composers("Benedito Lacerda, Nelson Angelo e Pixinguinha") == [
        "Benedito Lacerda",
        "Nelson Angelo",
        "Pixinguinha",
    ]
    assert split_composers("Ernesto Nazareth") == ["Ernesto Nazareth"]
    assert split_composers("  Tom Jobim e Tom Jobim ") == ["Tom Jobim"]
    assert split_composers("") == []


def test_life_dates_in_parentheses_are_not_part_of_the_name():
    assert split_composers("W. A. Mozart (1756-1791)") == ["W. A. Mozart"]
    assert split_composers("Banda (Ao Vivo)") == ["Banda (Ao Vivo)"]


def test_english_joiners_split_too():
    assert split_composers("John Smith and Jane Doe & Ann Lee / Bo Li") == [
        "John Smith",
        "Jane Doe",
        "Ann Lee",
        "Bo Li",
    ]


# --- The public-domain rule ---


def record(name, year, status="dead"):
    return AuthorRecord(name, "Q1", year, status, f"{ENTITY}Q1", "2026-10-20")


def test_the_limit_is_seventy_full_years_after_the_death_year():
    assert public_domain_limit(2026) == 1955
    assert is_public_domain([record("A", 1955)])
    assert not is_public_domain([record("A", 1956)])
    assert is_public_domain([record("A", 1956)], year=2027)


def test_every_author_must_be_dead_long_enough_and_unknown_authors_count_as_not_free():
    assert is_public_domain([record("A", 1934), record("B", 1947)])
    assert not is_public_domain([record("A", 1934), record("B", 1973)])
    assert not is_public_domain([record("A", 1934), record("B", None, "unknown")])
    assert not is_public_domain([record("A", None, "alive")])
    assert not is_public_domain([])


def test_a_song_is_free_only_when_every_name_of_its_composer_string_is():
    authors = {"Ernesto Nazareth": record("Ernesto Nazareth", 1934), "X": record("X", 1980)}
    assert song_is_public_domain("Ernesto Nazareth", authors)
    assert not song_is_public_domain("Ernesto Nazareth e X", authors)
    assert not song_is_public_domain("Ernesto Nazareth e Someone Unresolved", authors)
    assert not song_is_public_domain("", authors)


# --- SPARQL batches against a fake endpoint ---


def binding(name, qid, death=None, occupation=None, death_kind="literal"):
    row = {
        "name": {"type": "literal", "value": name, "xml:lang": "pt"},
        "person": {"type": "uri", "value": ENTITY + qid},
    }
    if death is not None:
        if death_kind == "literal":
            row["death"] = {
                "type": "literal",
                "value": death,
                "datatype": "http://www.w3.org/2001/XMLSchema#dateTime",
            }
        else:
            row["death"] = {
                "type": death_kind,
                "value": "http://www.wikidata.org/.well-known/genid/x",
            }
    if occupation is not None:
        row["occupation"] = {"type": "uri", "value": ENTITY + occupation}
    return row


WIKIDATA = {
    "Ernesto Nazareth": [binding("Ernesto Nazareth", "Q1", "1934-02-01T00:00:00Z", COMPOSER)],
    "Pixinguinha": [binding("Pixinguinha", "Q2", "1973-02-17T00:00:00Z", MUSICIAN)],
    "Caetano Veloso": [binding("Caetano Veloso", "Q3", None, MUSICIAN)],
    # Two people share the name; only one made music, so the musician wins.
    "Garoto": [
        binding("Garoto", "Q4", "1955-05-03T00:00:00Z", MUSICIAN),
        binding("Garoto", "Q5", "1990-01-01T00:00:00Z", FOOTBALLER),
    ],
    # Two musicians share the name and disagree: unknown.
    "Miguel": [
        binding("Miguel", "Q6", "1940-01-01T00:00:00Z", MUSICIAN),
        binding("Miguel", "Q7", None, COMPOSER),
    ],
    # Wikidata knows the person died but not when ("unknown value").
    "Zé Ninguém": [binding("Zé Ninguém", "Q8", "x", MUSICIAN, death_kind="bnode")],
}


class FakeEndpoint:
    """Answer SPARQL queries from WIKIDATA, recording the queries; an occupation per row."""

    def __init__(self):
        self.queries = []

    def __call__(self, query: str) -> dict:
        self.queries.append(query)
        rows = [row for name, rows in WIKIDATA.items() if f'"{name}"@pt' in query for row in rows]
        return {
            "head": {"vars": ["name", "person", "death", "occupation"]},
            "results": {"bindings": rows},
        }


class Pauses(list):
    def __call__(self, seconds):
        self.append(seconds)


def test_the_query_matches_humans_by_exact_portuguese_or_english_label_or_alias():
    query = sparql_query(["Pixinguinha", 'Joe "Jr" Doe'])
    assert '"Pixinguinha"@pt' in query and '"Pixinguinha"@en' in query
    assert '"Joe \\"Jr\\" Doe"@pt' in query  # quotes escaped
    assert "wdt:P31 wd:Q5" in query
    assert "rdfs:label|skos:altLabel" in query
    assert "wdt:P570" in query and "wdt:P106" in query


def test_names_are_resolved_dead_alive_or_unknown(tmp_path):
    names = [*WIKIDATA, "Nobody At All"]
    records = {
        r.name: r
        for r in resolve_names(names, tmp_path, FakeEndpoint(), Pauses(), today="2026-10-20")
    }

    assert records["Ernesto Nazareth"].status == "dead"
    assert records["Ernesto Nazareth"].death_year == 1934
    assert records["Ernesto Nazareth"].qid == "Q1"
    assert records["Ernesto Nazareth"].source == "https://www.wikidata.org/wiki/Q1"
    assert records["Ernesto Nazareth"].checked == "2026-10-20"
    assert (records["Pixinguinha"].status, records["Pixinguinha"].death_year) == ("dead", 1973)
    assert (records["Caetano Veloso"].status, records["Caetano Veloso"].death_year) == (
        "alive",
        None,
    )
    assert (records["Garoto"].qid, records["Garoto"].death_year) == ("Q4", 1955)
    assert (records["Miguel"].status, records["Miguel"].qid) == ("unknown", None)
    assert records["Zé Ninguém"].status == "unknown"
    assert (records["Nobody At All"].status, records["Nobody At All"].qid) == ("unknown", None)


def test_queries_go_in_batches_of_fifty_at_least_one_second_apart(tmp_path):
    endpoint, pauses = FakeEndpoint(), Pauses()
    names = [f"Name {number:03d}" for number in range(120)]
    resolve_names(names, tmp_path, endpoint, pauses, today="2026-10-20")

    assert BATCH_SIZE == 50
    assert len(endpoint.queries) == 3
    assert len(pauses) == 2 and all(seconds >= 1.0 for seconds in pauses)


def test_a_rerun_reads_the_cache_and_touches_no_network(tmp_path):
    first = resolve_names(list(WIKIDATA), tmp_path, FakeEndpoint(), Pauses(), today="2026-10-20")
    endpoint = FakeEndpoint()
    again = resolve_names(list(WIKIDATA), tmp_path, endpoint, Pauses(), today="2027-01-01")

    assert endpoint.queries == []
    assert again == first  # the recorded check date is the date of the query, not of the rerun


def test_only_names_missing_from_the_cache_are_queried(tmp_path):
    resolve_names(["Pixinguinha"], tmp_path, FakeEndpoint(), Pauses(), today="2026-10-20")
    endpoint = FakeEndpoint()
    resolve_names(["Pixinguinha", "Garoto"], tmp_path, endpoint, Pauses(), today="2026-10-21")

    assert len(endpoint.queries) == 1
    assert '"Garoto"@pt' in endpoint.queries[0]
    assert '"Pixinguinha"@pt' not in endpoint.queries[0]


def test_authors_json_round_trips_sorted_by_name(tmp_path):
    records = resolve_names(
        list(WIKIDATA), tmp_path / "cache", FakeEndpoint(), Pauses(), today="2026-10-20"
    )
    path = write_authors(reversed(records), tmp_path / "authors.json")
    stored = json.loads(path.read_text(encoding="utf-8"))

    assert [author["name"] for author in stored["authors"]] == sorted(WIKIDATA)
    assert set(stored["authors"][0]) == {"name", "qid", "death_year", "status", "source", "checked"}
    assert read_authors(path) == {r.name: r for r in records}
    assert write_authors(records, tmp_path / "again.json").read_bytes() == path.read_bytes()


def test_the_catalog_authors_command_is_registered():
    parser = argparse.ArgumentParser()
    add_catalog_parser(parser.add_subparsers(dest="command", required=True))
    args = parser.parse_args(["catalog", "authors"])
    assert args.out.as_posix() == "data/catalog/authors.json"
    assert args.cache.as_posix() == "data/raw/wikidata"


@pytest.mark.parametrize("delay", [0.0, 0.5])
def test_a_delay_under_one_second_is_refused(tmp_path, delay):
    with pytest.raises(ValueError):
        resolve_names(["A"], tmp_path, FakeEndpoint(), Pauses(), today="2026-10-20", delay=delay)


def test_a_failed_query_is_retried_after_a_longer_pause(tmp_path):
    endpoint, pauses = FakeEndpoint(), Pauses()
    failures = [OSError("HTTP Error 429: Too Many Requests")]

    def flaky(query):
        if failures:
            raise failures.pop()
        return endpoint(query)

    records = resolve_names(["Pixinguinha"], tmp_path, flaky, pauses, today="2026-10-20")
    assert records[0].death_year == 1973
    assert pauses and pauses[0] >= 5.0


def test_a_caller_that_just_queried_can_ask_for_a_pause_before_the_first_batch(tmp_path):
    pauses = Pauses()
    resolve_names(
        ["Garoto"], tmp_path, FakeEndpoint(), pauses, today="2026-10-20", pause_first=True
    )
    assert pauses == [1.0]
    cached = Pauses()
    resolve_names(
        ["Garoto"], tmp_path, FakeEndpoint(), cached, today="2026-10-20", pause_first=True
    )
    assert cached == []  # nothing to query, nothing to wait for


def test_the_authors_file_keeps_every_mpb_name_but_only_the_resolved_pdmx_names(tmp_path):
    from catalog.authors import run_authors
    from catalog.cards import ENVELOPE_FIELDS, write_catalog_file

    envelope = dict.fromkeys(ENVELOPE_FIELDS, "x")
    mpb = write_catalog_file(
        tmp_path / "mpb.json", envelope, [{"id": "a", "t": "A", "c": "Pixinguinha e Nobody At All"}]
    )
    columns = (
        "path,mid,is_original,n_ratings,rating,license,license_url,song_name,title,composer_name,"
        "artist_name,song_length.bars,is_best_unique_arrangement,subset:no_license_conflict"
    )
    rows = [
        "./data/a.json,./mid/a.mid,False,1,4.0,publicdomain,,A,A,Ernesto Nazareth,u,32,True,True",
        "./data/b.json,./mid/b.mid,False,1,3.0,publicdomain,,B,B,Some Unknown,u,32,True,True",
    ]
    (tmp_path / "PDMX.csv").write_text("\n".join([columns, *rows]) + "\n", encoding="utf-8")
    parser = argparse.ArgumentParser()
    add_catalog_parser(parser.add_subparsers(dest="command", required=True))
    args = parser.parse_args(
        ["catalog", "authors", "--out", str(tmp_path / "authors.json"), "--cache", str(tmp_path)]
        + ["--mpb", str(mpb), "--public-domain", str(tmp_path / "none.json")]
        + ["--pdmx", str(tmp_path / "PDMX.csv"), "--delay", "1.0"]
    )

    run_authors(args, fetch=FakeEndpoint(), sleep=Pauses())

    names = sorted(read_authors(tmp_path / "authors.json"))
    assert names == ["Ernesto Nazareth", "Nobody At All", "Pixinguinha"]
