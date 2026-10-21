"""How popular each catalog song is: Wikipedia page views, PDMX views and a curated list.

The song browser lists the most popular songs first, so every catalog entry carries `pop`, a
non-negative integer (higher is more popular). MPB and public-domain songs take the Wikipedia
page views of the last 12 months of the matched song article; a song without a safe match
takes a twentieth of its best-known artist's page views. These tests never touch the network:
fake fetchers answer with responses shaped like Wikidata's SPARQL results and Wikimedia's
pageviews API.
"""

import argparse
import json
import re
from datetime import date
from urllib.parse import unquote

import pytest

from catalog.cards import ENVELOPE_FIELDS, catalog_text
from catalog.crawl import add_catalog_parser
from catalog.popularity import (
    ARTIST_DIVISOR,
    NOTTINGHAM_FAMOUS_POP,
    SongCandidate,
    article_views,
    people_match,
    resolve_artists,
    resolve_songs,
    title_key,
    title_variants,
    views_period,
)

TODAY = date(2026, 10, 21)
ENTITY = "http://www.wikidata.org/entity/"


# --- Fakes: the two web services ---


class FakeWikidata:
    """Answers songs and artist queries from tables, and remembers every query it got."""

    def __init__(self, songs=None, artists=None):
        self.songs = songs or {}  # title -> [(qid, pt, en, [people])]
        self.artists = artists or {}  # name -> [(qid, pt, en)]
        self.queries = []

    def __call__(self, query):
        self.queries.append(query)
        bindings = []
        if "?people" in query:
            for title, items in self.songs.items():
                if f'"{title}"@pt' not in query:
                    continue
                for qid, pt, en, people in items:
                    row = {
                        "name": {"value": title},
                        "song": {"value": ENTITY + qid},
                        "people": {"value": "|".join(people)},
                    }
                    if pt:
                        row["ptTitle"] = {"value": pt}
                    if en:
                        row["enTitle"] = {"value": en}
                    bindings.append(row)
        else:
            for name, items in self.artists.items():
                if f'"{name}"@pt' not in query:
                    continue
                for qid, pt, en in items:
                    row = {"name": {"value": name}, "who": {"value": ENTITY + qid}}
                    if pt:
                        row["ptTitle"] = {"value": pt}
                    if en:
                        row["enTitle"] = {"value": en}
                    bindings.append(row)
        return {"results": {"bindings": bindings}}


class FakePageviews:
    """Answers per-article monthly requests: `views[(project, article)]` is the yearly total."""

    PATTERN = re.compile(
        r"per-article/(\w+)\.wikipedia/all-access/user/([^/]+)/monthly/(\d+)/(\d+)"
    )

    def __init__(self, views):
        self.views = views
        self.urls = []

    def __call__(self, url):
        self.urls.append(url)
        project, article, start, end = self.PATTERN.search(url).groups()
        total = self.views.get((project, unquote(article).replace("_", " ")))
        if total is None:
            return None  # the API answers 404 when an article had no views
        return {
            "items": [
                {"timestamp": f"{start[:6]}0100", "views": total // 2},
                {"timestamp": f"{end[:6]}0100", "views": total - total // 2},
            ]
        }


def no_sleep(seconds):
    pass


# --- Titles and people ---


def test_title_keys_ignore_case_accents_and_punctuation():
    assert title_key("ÁGUAS DE MARÇO") == title_key("Águas de Março") == "aguas de marco"
    assert title_key('"VAMO" EMBOLANDO!') == "vamo embolando"
    assert title_key("Maria,   Maria") == "maria maria"


def test_title_variants_cover_the_spellings_wikidata_uses():
    variants = title_variants("A FONTE DO LAMBARI")
    assert "A Fonte do Lambari" in variants  # title case, small words lower
    assert "A fonte do lambari" in variants  # sentence case
    assert title_variants('"VAMO" EMBOLANDO')[0] == "Vamo Embolando"
    assert len(set(variants)) == len(variants)
    assert "Maria Maria" in title_variants("MARIA, MARIA")  # some labels drop the comma


def test_a_song_matches_only_when_a_surname_of_its_authors_is_among_the_wikidata_people():
    candidate = SongCandidate("Q1", "Aquarela", None, ("Toquinho", "Vinícius de Moraes"))
    assert people_match("Toquinho", "Toquinho", candidate)
    assert people_match("Toquinho", "", candidate)
    assert people_match("Vinicius de Moraes e Toquinho", "Banda X", candidate)  # accents ignored
    assert not people_match("Fulano de Tal", "Banda X", candidate)
    assert not people_match("", "", candidate)


def test_a_surname_shared_by_thousands_needs_the_whole_name():
    candidate = SongCandidate("Q2", "Saudade", None, ("Ana Silva",))
    assert not people_match("João Silva", "", candidate)
    assert people_match("Ana Silva", "", candidate)


def test_a_person_with_a_suffix_matches_on_the_name_before_it():
    candidate = SongCandidate("Q3", "Samba", None, ("Luis Bonfa",))
    assert people_match("Luis Bonfa Junior", "", candidate)


def test_a_song_without_authors_on_wikidata_never_matches():
    candidate = SongCandidate("Q4", "Asa Branca", "Asa Branca", ())
    assert not people_match("Luiz Gonzaga", "Luiz Gonzaga", candidate)


# --- Wikidata: songs and artists, cached ---


def test_song_candidates_come_from_one_query_per_batch_and_the_cache_makes_a_rerun_free(tmp_path):
    wikidata = FakeWikidata(
        songs={"Aquarela": [("Q10", "Aquarela (canção)", "Aquarela (song)", ["Toquinho"])]}
    )
    titles = ["AQUARELA", "Sem Resposta"]

    first = resolve_songs(titles, tmp_path, wikidata, no_sleep, today="2026-10-21", log=len)
    assert len(wikidata.queries) == 1
    assert first[title_key("Aquarela")] == [
        SongCandidate("Q10", "Aquarela (canção)", "Aquarela (song)", ("Toquinho",))
    ]
    assert first[title_key("Sem Resposta")] == []  # asked, nobody knows it

    again = resolve_songs(titles, tmp_path, wikidata, no_sleep, log=len)
    assert again == first
    assert len(wikidata.queries) == 1  # nothing asked twice


def test_song_queries_wait_a_second_between_batches(tmp_path):
    waits = []
    titles = [f"Song {number}" for number in range(70)]
    wikidata = FakeWikidata()

    resolve_songs(titles, tmp_path, wikidata, waits.append, log=len)

    assert len(wikidata.queries) == 3  # 30 titles per batch
    assert waits == [1.0, 1.0]


def test_a_batch_that_keeps_timing_out_is_split_in_halves_until_it_goes_through(tmp_path):
    class HeavyBatches(FakeWikidata):
        def __call__(self, query):
            if sum(f'"{n}"@pt' in query for n in self.artists) > 2:
                raise OSError("HTTP Error 504: Gateway Timeout")  # too heavy a query
            return super().__call__(query)

    names = ["Ana", "Bia", "Caio", "Dani", "Edu"]
    wikidata = HeavyBatches(artists={name: [(f"Q{n}", name, None)] for n, name in enumerate(names)})

    found = resolve_artists(names, tmp_path, wikidata, no_sleep, log=len)

    assert sorted(found) == names


def test_a_single_name_whose_query_always_times_out_stays_unresolved(tmp_path):
    class NeverAlex(FakeWikidata):
        def __call__(self, query):
            if '"Alex"@pt' in query:
                raise OSError("HTTP Error 504: Gateway Timeout")  # a name with endless namesakes
            return super().__call__(query)

    wikidata = NeverAlex(artists={"Bia": [("Q1", "Bia", None)]})

    found = resolve_artists(["Alex", "Bia"], tmp_path, wikidata, no_sleep, log=len)

    assert found == {"Bia": ("Bia", None)}


def test_the_song_query_leaves_albums_out_and_asks_for_wikipedia_articles(tmp_path):
    wikidata = FakeWikidata()
    resolve_songs(["Aquarela"], tmp_path, wikidata, no_sleep, log=len)
    query = wikidata.queries[0]

    assert "wd:Q2188189" in query  # musical work
    assert "MINUS" in query and "wd:Q482994" in query  # not an album
    assert "pt.wikipedia.org" in query and "en.wikipedia.org" in query


def test_artists_resolve_to_one_candidate_and_ambiguous_names_stay_unresolved(tmp_path):
    wikidata = FakeWikidata(
        artists={
            "Toquinho": [("Q20", "Toquinho", "Toquinho")],
            "Leo": [("Q21", "Leo", None), ("Q22", "Leo (cantor)", None)],
        }
    )
    found = resolve_artists(["Toquinho", "Leo", "Ninguém"], tmp_path, wikidata, no_sleep, log=len)

    assert found["Toquinho"] == ("Toquinho", "Toquinho")
    assert "Leo" not in found  # two musicians with the name: not safe
    assert "Ninguém" not in found


# --- Wikipedia page views ---


def test_the_period_is_the_last_twelve_full_months():
    assert views_period(date(2026, 10, 21)) == ("2025100100", "2026093000")
    assert views_period(date(2026, 1, 3)) == ("2025010100", "2025123100")


def test_article_views_sum_the_months_and_are_cached(tmp_path):
    pageviews = FakePageviews({("pt", "Aquarela (canção)"): 1000})
    reader = {"cache_dir": tmp_path, "fetch": pageviews, "sleep": no_sleep, "today": TODAY}

    assert article_views("pt", "Aquarela (canção)", **reader) == 1000
    assert article_views("pt", "Aquarela (canção)", **reader) == 1000
    assert len(pageviews.urls) == 1
    assert "Aquarela_%28can%C3%A7%C3%A3o%29" in pageviews.urls[0]
    assert "pt.wikipedia/all-access/user" in pageviews.urls[0]


def test_an_article_without_data_counts_zero_and_is_cached_too(tmp_path):
    pageviews = FakePageviews({})
    reader = {"cache_dir": tmp_path, "fetch": pageviews, "sleep": no_sleep, "today": TODAY}

    assert article_views("en", "Nothing", **reader) == 0
    assert article_views("en", "Nothing", **reader) == 0
    assert len(pageviews.urls) == 1


def test_page_views_are_asked_five_times_a_second_at_most(tmp_path):
    waits = []
    pageviews = FakePageviews({("pt", "A"): 10, ("pt", "B"): 20})
    for article in ("A", "B", "A"):
        article_views("pt", article, tmp_path, pageviews, waits.append, today=TODAY, delay=0.2)

    assert len(pageviews.urls) == 2
    assert waits == [0.2, 0.2]  # a wait before each request, none for the cached one


def test_a_cache_from_another_period_is_asked_again(tmp_path):
    pageviews = FakePageviews({("pt", "A"): 10})
    article_views("pt", "A", tmp_path, pageviews, no_sleep, today=date(2026, 10, 21))
    article_views("pt", "A", tmp_path, pageviews, no_sleep, today=date(2027, 1, 5))
    assert len(pageviews.urls) == 2


def test_the_pageviews_delay_below_the_polite_minimum_is_refused(tmp_path):
    with pytest.raises(ValueError, match="at least"):
        article_views("pt", "A", tmp_path, FakePageviews({}), no_sleep, today=TODAY, delay=0.05)


# --- The whole pass over catalog files ---


def entry(song_id, title, composers="", performer="", **extra):
    return {
        "id": song_id,
        "source": "mpb",
        "t": title,
        "c": composers,
        "p": performer,
        "u": f"https://example.org/{song_id}.html",
        "license": "all-rights-reserved",
        "seed": 1,
        **extra,
    }


MIDI = "https://example.org/som/{}.mid"


def mpb_entry(song_id, title, composers="", performer=""):
    return entry(
        song_id,
        title,
        composers,
        performer,
        route={"server": f"/songs/mpb/{song_id}.abc"},
        facts={"midi": MIDI.format(song_id), "key": "c major"},
    )


def write_catalog(path, source, entries, generated="uv run src/main.py catalog demo"):
    envelope = dict.fromkeys(ENVELOPE_FIELDS, "x") | {"source": source, "generated": generated}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(catalog_text(envelope, entries), encoding="utf-8")
    return path


def catalog_parser():
    parser = argparse.ArgumentParser()
    add_catalog_parser(parser.add_subparsers(dest="command", required=True))
    return parser


PDMX_HEADER = (
    "path,mid,n_views,n_favorites,n_ratings,rating,license,song_name,title,composer_name,"
    "artist_name,song_length.bars,is_best_unique_arrangement,subset:no_license_conflict"
)


def build_workspace(tmp_path):
    """Five tiny catalog files, a PDMX table, and the fake services that know their songs."""
    catalogs = tmp_path / "catalog"
    mpb = [
        mpb_entry("aquarela", "AQUARELA", "Toquinho e Vinícius de Moraes", "Toquinho"),
        mpb_entry("saudade", "SAUDADE", "Fulano de Tal", "Banda Obscura"),
        mpb_entry("so-artista", "UMA CANÇÃO RARA", "Beltrano", "Marisa Monte"),
        entry("quebrada", "QUEBRADA", "X", "Y", facts={"midi": MIDI.format("quebrada")}, error="x"),
    ]
    write_catalog(catalogs / "mpb.json", "mpb", mpb, "uv run src/main.py catalog analyze")
    write_catalog(
        catalogs / "public-domain.json",
        "public-domain",
        [
            entry(
                "1922",
                "1922",
                "Ernesto Nazareth",
                "Ernesto Nazareth",
                license="public-domain",
                route={"abc": "data/catalog/abc/public-domain/1922.abc", "tune": 0},
                facts={"midi": MIDI.format("1922")},
            )
        ],
    )
    write_catalog(
        catalogs / "nottingham.json",
        "nottingham",
        [
            entry("morris-4", "Blue Bells of Scotland", route={"abc": "a.abc", "tune": 0}),
            entry("jigs-9", "Some Local Jig", route={"abc": "b.abc", "tune": 0}),
        ],
    )
    write_catalog(
        catalogs / "examples.json",
        "examples",
        [
            entry("korobeiniki", "Korobeiniki", order=2, route={"abc": "k.abc", "tune": 0}),
            entry("ievan_polkka", "Ievan Polkka", order=1, route={"abc": "i.abc", "tune": 0}),
        ],
    )
    write_catalog(
        catalogs / "pdmx.json",
        "pdmx",
        [
            entry(
                "QmBIG",
                "Big Toccata",
                "Bach",
                route={"abc": "big.abc", "tune": 0},
                facts={"midi": "mid/1/QmBIGfull.mid"},
            ),
            entry(
                "QmSMALL",
                "Small Minuet",
                "Bach",
                route={"abc": "small.abc", "tune": 0},
                facts={"midi": "mid/2/QmSMALLfull.mid"},
            ),
        ],
    )
    pdmx = tmp_path / "PDMX.csv"
    pdmx.write_text(
        "\n".join(
            [
                PDMX_HEADER,
                "./data/1/QmBIGfull.json,./mid/1/QmBIGfull.mid,100000,1000,500,4.8,"
                "publicdomain,Big Toccata,,Bach,,40,True,True",
                "./data/2/QmSMALLfull.json,./mid/2/QmSMALLfull.mid,100,2,NA,NA,"
                "publicdomain,Small Minuet,,Bach,,40,True,True",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    wikidata = FakeWikidata(
        songs={
            "Aquarela": [("Q10", "Aquarela (canção)", "Aquarela (song)", ["Toquinho"])],
            "Saudade": [("Q11", "Saudade (canção)", None, ["Claudia Leitte"])],
            "1922": [("Q12", "1922 (canção)", None, ["Ernesto Nazareth"])],
        },
        artists={
            "Marisa Monte": [("Q30", "Marisa Monte", "Marisa Monte")],
            "Banda Obscura": [],
        },
    )
    pageviews = FakePageviews(
        {
            ("pt", "Aquarela (canção)"): 12000,
            ("en", "Aquarela (song)"): 3000,
            ("pt", "Saudade (canção)"): 900000,  # a famous song, but not this one
            ("pt", "1922 (canção)"): 40,
            ("pt", "Marisa Monte"): 40000,
            ("en", "Marisa Monte"): 20000,
        }
    )
    return catalogs, pdmx, wikidata, pageviews


def run_popularity(tmp_path, catalogs, pdmx, wikidata, pageviews):
    args = catalog_parser().parse_args(
        [
            "catalog",
            "popularity",
            "--catalog-dir",
            str(catalogs),
            "--pdmx",
            str(pdmx),
            "--cache",
            str(tmp_path / "cache"),
        ]
    )
    return args.handler(args, wikidata, pageviews, no_sleep, TODAY)


def read_entries(catalogs, source):
    record = json.loads((catalogs / f"{source}.json").read_text(encoding="utf-8"))
    return {entry["id"]: entry for entry in record["entries"]}


def test_a_matched_song_takes_its_page_views_of_both_wikipedias(tmp_path):
    catalogs, pdmx, wikidata, pageviews = build_workspace(tmp_path)
    run_popularity(tmp_path, catalogs, pdmx, wikidata, pageviews)

    assert read_entries(catalogs, "mpb")["aquarela"]["pop"] == 15000


def test_a_song_whose_authors_differ_from_the_wikidata_song_is_not_matched(tmp_path):
    """The generic title "Saudade" must not borrow the page views of another Saudade."""
    catalogs, pdmx, wikidata, pageviews = build_workspace(tmp_path)
    run_popularity(tmp_path, catalogs, pdmx, wikidata, pageviews)

    mpb = read_entries(catalogs, "mpb")
    assert mpb["saudade"]["pop"] == 0  # no match and an unknown artist
    assert not any("Saudade" in url for url in pageviews.urls)  # its views were never even read


def test_an_unmatched_song_takes_its_artists_page_views_over_twenty(tmp_path):
    catalogs, pdmx, wikidata, pageviews = build_workspace(tmp_path)
    run_popularity(tmp_path, catalogs, pdmx, wikidata, pageviews)

    assert ARTIST_DIVISOR == 20
    assert read_entries(catalogs, "mpb")["so-artista"]["pop"] == (40000 + 20000) // 20


def test_a_famous_artist_ranks_a_song_below_a_matched_famous_one_but_above_an_obscure_one(tmp_path):
    catalogs, pdmx, wikidata, pageviews = build_workspace(tmp_path)
    run_popularity(tmp_path, catalogs, pdmx, wikidata, pageviews)

    mpb = read_entries(catalogs, "mpb")
    assert mpb["aquarela"]["pop"] > mpb["so-artista"]["pop"] > mpb["saudade"]["pop"]


def test_the_public_domain_card_is_matched_the_same_way(tmp_path):
    catalogs, pdmx, wikidata, pageviews = build_workspace(tmp_path)
    run_popularity(tmp_path, catalogs, pdmx, wikidata, pageviews)

    assert read_entries(catalogs, "public-domain")["1922"]["pop"] == 40


def test_pdmx_scores_use_their_own_views_favorites_and_ratings(tmp_path):
    catalogs, pdmx, wikidata, pageviews = build_workspace(tmp_path)
    run_popularity(tmp_path, catalogs, pdmx, wikidata, pageviews)

    pdmx_entries = read_entries(catalogs, "pdmx")
    # (views + 20 * favorites + 50 * n_ratings * rating / 5) / 5
    assert pdmx_entries["QmBIG"]["pop"] == round((100000 + 20 * 1000 + 50 * 500 * 4.8 / 5) / 5)
    assert pdmx_entries["QmSMALL"]["pop"] == round((100 + 20 * 2) / 5)  # NA ratings count zero
    assert pdmx_entries["QmBIG"]["pop"] > pdmx_entries["QmSMALL"]["pop"]


def test_nottingham_famous_tunes_get_a_fixed_high_value_and_the_others_one(tmp_path):
    catalogs, pdmx, wikidata, pageviews = build_workspace(tmp_path)
    run_popularity(tmp_path, catalogs, pdmx, wikidata, pageviews)

    nottingham = read_entries(catalogs, "nottingham")
    assert nottingham["morris-4"]["pop"] == NOTTINGHAM_FAMOUS_POP
    assert nottingham["jigs-9"]["pop"] == 1


def test_the_examples_head_the_popular_list_in_their_curated_order(tmp_path):
    catalogs, pdmx, wikidata, pageviews = build_workspace(tmp_path)
    run_popularity(tmp_path, catalogs, pdmx, wikidata, pageviews)

    examples = read_entries(catalogs, "examples")
    everything = [
        entry["pop"]
        for source in ("mpb", "public-domain", "nottingham", "pdmx")
        for entry in read_entries(catalogs, source).values()
    ]
    assert examples["ievan_polkka"]["pop"] > examples["korobeiniki"]["pop"] > max(everything)


def test_mpb_routes_become_downloads_and_errors_stay_without_a_route(tmp_path):
    catalogs, pdmx, wikidata, pageviews = build_workspace(tmp_path)
    run_popularity(tmp_path, catalogs, pdmx, wikidata, pageviews)

    mpb = read_entries(catalogs, "mpb")
    assert mpb["aquarela"]["route"] == {"download": MIDI.format("aquarela")}
    assert "route" not in mpb["quebrada"]
    assert read_entries(catalogs, "public-domain")["1922"]["route"]["abc"].endswith("1922.abc")


def test_only_pop_and_the_mpb_route_and_the_generated_line_change(tmp_path):
    catalogs, pdmx, wikidata, pageviews = build_workspace(tmp_path)
    before = {
        source: json.loads((catalogs / f"{source}.json").read_text(encoding="utf-8"))
        for source in ("examples", "mpb", "public-domain", "nottingham", "pdmx")
    }
    run_popularity(tmp_path, catalogs, pdmx, wikidata, pageviews)

    for source, old in before.items():
        new = json.loads((catalogs / f"{source}.json").read_text(encoding="utf-8"))
        assert [e["id"] for e in new["entries"]] == [e["id"] for e in old["entries"]]
        for old_entry, new_entry in zip(old["entries"], new["entries"], strict=True):
            assert isinstance(new_entry["pop"], int) and new_entry["pop"] >= 0
            rest = {k: v for k, v in new_entry.items() if k != "pop"}
            if source == "mpb" and "route" in rest:
                rest["route"] = old_entry["route"]
            assert rest == old_entry
        assert {k: v for k, v in new.items() if k not in ("entries", "generated")} == {
            k: v for k, v in old.items() if k not in ("entries", "generated")
        }
        assert new["generated"].startswith(old["generated"])
        assert "uv run src/main.py catalog popularity" in new["generated"]


def test_a_second_run_changes_nothing_and_asks_nothing(tmp_path):
    catalogs, pdmx, wikidata, pageviews = build_workspace(tmp_path)
    run_popularity(tmp_path, catalogs, pdmx, wikidata, pageviews)
    first = {path.name: path.read_bytes() for path in catalogs.glob("*.json")}
    asked = (len(wikidata.queries), len(pageviews.urls))

    run_popularity(tmp_path, catalogs, pdmx, wikidata, pageviews)

    assert {path.name: path.read_bytes() for path in catalogs.glob("*.json")} == first
    assert (len(wikidata.queries), len(pageviews.urls)) == asked


def test_the_run_reports_how_many_songs_matched_an_article(tmp_path, capsys):
    catalogs, pdmx, wikidata, pageviews = build_workspace(tmp_path)
    run_popularity(tmp_path, catalogs, pdmx, wikidata, pageviews)

    printed = capsys.readouterr().out
    assert "2 of 5 MPB and public-domain songs matched a Wikipedia article" in printed
