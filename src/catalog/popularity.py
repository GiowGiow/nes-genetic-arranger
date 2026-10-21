"""How popular each catalog song is, so the song browser can list the best-known songs first.

Every entry of every catalog file carries `pop`, a non-negative integer: the higher, the more
people know the song. The numbers of different sources are only roughly comparable; they sit on
one scale, about "readers per year", so a mixed list still reads sensibly. `catalog popularity`
adds the field and rewrites the files; it is the last step after the other `catalog` commands,
which write entries without it.

**MPB and public domain** (Beatriz Kauffmann's songs). A song's popularity is the number of times
its Wikipedia article was read in the last 12 full months, summed over the Portuguese and the
English Wikipedia (Wikimedia pageviews API, `per-article`, `monthly`, readers only, no bots).
Finding the article is the risky part: a title like "Saudade" names hundreds of songs and
albums. So a match is accepted only when both hold:

1. the normalized title (no accents, no letter case, no punctuation) equals the label or alias
   of a Wikidata musical work (albums left out) that has a pt or en Wikipedia article;
2. a name of the entry's composers or performer is among the labels of the item's composer,
   lyricist, performer, author or creator (`people_match`): the surname must appear, or the
   whole name when the surname is one that thousands share ("Silva").

A song with no safe match falls back to its best-known artist: each composer and the performer
is looked up on Wikidata by exact name (a musician or a musical ensemble with a Wikipedia
article; a name shared by two musicians stays unresolved), and the song gets the best of their
12-month page views divided by 20. So a song by a famous artist still outranks an obscure one,
but ranks below a matched famous song. An artist or song nobody could match gets 0.

**PDMX** has its own counters (MuseScore views, favorites, ratings, all-time, not yearly):
`pop = (views + 20 * favorites + 50 * n_ratings * rating / 5) / 5`. A favorite or a rating is a
rarer act than a view, hence the weights; the final division by 5 turns an all-time count into a
rough yearly one, like the Wikipedia numbers. A missing counter counts as zero.

**Nottingham**: the tunes listed in `NOTTINGHAM_FAMOUS` (the ones people know by name) get a fixed
high value, `NOTTINGHAM_FAMOUS_POP`; the other tunes get 1.

**Examples** are the curated set: `10,000,000 - order`, above every other song, in their order.

**MPB route.** The song server was withdrawn, so an MPB entry's route becomes
`{"download": <the MIDI link>}`: the browser app downloads the file and takes it as a dropped
file. Entries with an error keep no route.

Politeness: the project's User-Agent, Wikidata at least one second apart and the pageviews API
at most five requests per second. Every answer is cached under `data/raw/popularity/` (never
committed), so a rerun needs no network. Network access happens only in `fetch_pageviews` and
authors' `post_sparql`; the tests pass fakes.
"""

import argparse
import csv
import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

from catalog.authors import (
    BATCH_SIZE,
    ENTITY_PREFIX,
    MINIMUM_DELAY_SECONDS,
    MUSIC_OCCUPATIONS,
    _escaped,
    _fetch_with_retries,
    post_sparql,
    split_composers,
)
from catalog.cards import ENVELOPE_FIELDS, normalized_title, write_catalog_file
from catalog.collections import CATALOG_ROOT, NOTTINGHAM_FAMOUS
from leadsheet.sources import USER_AGENT

PAGEVIEWS_URL = (
    "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/"
    "{project}.wikipedia/all-access/user/{article}/monthly/{start}/{end}"
)
DEFAULT_CACHE = Path("data/raw/popularity")
DEFAULT_PDMX = Path("data/raw/pdmx/PDMX.csv")
SOURCES = ("examples", "nottingham", "pdmx", "mpb", "public-domain")
POPULARITY_COMMAND = "uv run src/main.py catalog popularity"

SONG_BATCH_SIZE = 30  # titles per query: each has up to a dozen spellings in the VALUES list
PAGEVIEWS_DELAY_SECONDS = 0.2  # at most five requests per second
PAGEVIEWS_TIMEOUT_SECONDS = 30
PAGEVIEWS_RETRIES = 4
PAGEVIEWS_RETRY_PAUSE_SECONDS = 5.0
ARTIST_DIVISOR = 20  # a song takes its artist's page views over this
NOTTINGHAM_FAMOUS_POP = 20_000
NOTTINGHAM_OTHER_POP = 1
EXAMPLES_POP_BASE = 10_000_000  # above every Wikipedia count; minus the example's `order`
PDMX_FAVORITE_WEIGHT = 20
PDMX_RATING_WEIGHT = 50
PDMX_ALL_TIME_DIVISOR = 5


def _words(text: str) -> frozenset[str]:
    return frozenset(text.split())


MUSICAL_WORK = "Q2188189"
ALBUM = "Q482994"
MUSICAL_ENSEMBLE = "Q2088357"
# Words a title keeps in lower case in the middle of a line ("A Fonte do Lambari").
SMALL_WORDS = _words(
    "a o as os um uma de da do das dos e em no na nos nas ao à para pra por com ou "
    "the of and in on at to for an by with from"
)
# Name endings that are not a surname: "Luis Bonfa Junior" is known by "Bonfa".
NAME_SUFFIXES = frozenset({"jr", "junior", "filho", "neto", "sobrinho", "segundo"})
# Surnames shared by so many people that they prove nothing alone (the whole name is needed).
COMMON_SURNAMES = _words(
    "silva santos oliveira souza sousa pereira costa rodrigues almeida nascimento lima araujo "
    "fernandes carvalho gomes martins rocha ribeiro alves monteiro mendes barros freitas "
    "barbosa pinto moreira cavalcanti dias castro campos cardoso smith jones brown johnson "
    "williams taylor davis miller wilson moore anderson thomas jackson white harris martin "
    "garcia lee young king"
)

Fetch = Callable[[str], dict]
PageviewsFetch = Callable[[str], dict | None]


@dataclass(frozen=True)
class SongCandidate:
    """One Wikidata musical work that has a Wikipedia article and carries a given title.

    Attributes:
        qid: the Wikidata item, e.g. "Q249859".
        pt_title: title of its Portuguese Wikipedia article, or None.
        en_title: title of its English Wikipedia article, or None.
        people: labels of its composers, lyricists, performers, authors and creators.
    """

    qid: str
    pt_title: str | None
    en_title: str | None
    people: tuple[str, ...]


# --- Titles and people ---


def title_key(text: str) -> str:
    """Return the key two spellings of a title share: no accents, case or punctuation.

    >>> title_key("ÁGUAS DE MARÇO") == title_key("Águas de Março")
    True
    >>> title_key('"VAMO" EMBOLANDO!')
    'vamo embolando'
    """
    plain = normalized_title(text)
    return " ".join(re.sub(r"[^0-9a-z]+", " ", plain).split())


def _capitalized(word: str) -> str:
    for index, char in enumerate(word):
        if char.isalnum():
            return word[:index] + char.upper() + word[index + 1 :]
    return word


def title_variants(title: str) -> list[str]:
    """Return the spellings Wikidata labels may use for a title: title case, sentence case, as is.

    The MPB site writes titles in capitals, Wikidata in title case (English) or with small words
    in lower case (Portuguese); SPARQL compares labels exactly, so each spelling is tried, with
    and without the title's punctuation ("Maria, Maria" is labeled "Maria Maria" by some).

    >>> title_variants("A FONTE DO LAMBARI")
    ['A Fonte do Lambari', 'A fonte do lambari', 'A FONTE DO LAMBARI']
    """
    cleaned = " ".join(title.replace('"', "").replace("“", "").replace("”", "").split())
    unpunctuated = " ".join(re.sub(r"[^\w\s'-]", "", cleaned).split())
    variants = []
    for base in (cleaned, unpunctuated):
        words = base.lower().split(" ")
        title_case = " ".join(
            word
            if index and word in SMALL_WORDS
            else "-".join(_capitalized(part) for part in word.split("-"))
            for index, word in enumerate(words)
        )
        variants += [title_case, _capitalized(base.lower()), base]
    return list(dict.fromkeys(variant for variant in variants if variant))


def _person_tokens(name: str) -> list[str]:
    return title_key(name).split()


def _surname(tokens: Sequence[str]) -> str:
    if len(tokens) > 1 and tokens[-1] in NAME_SUFFIXES:
        return tokens[-2]
    return tokens[-1] if tokens else ""


def _same_person(name_tokens: Sequence[str], label_tokens: set[str]) -> bool:
    if not name_tokens:
        return False
    if set(name_tokens) <= label_tokens:  # the whole name, in any order ("Marisa Monte")
        return True
    surname = _surname(name_tokens)
    return len(surname) >= 3 and surname not in COMMON_SURNAMES and surname in label_tokens


def people_match(composers: str, performer: str, candidate: SongCandidate) -> bool:
    """Say whether a name of the entry's authors is among the Wikidata song's people.

    A name matches a label when all its words are in the label, or when its surname is (unless
    the surname is as common as "Silva"). Accents and letter case do not matter.

    >>> candidate = SongCandidate("Q1", "Aquarela", None, ("Toquinho", "Vinícius de Moraes"))
    >>> people_match("Vinicius de Moraes e Toquinho", "", candidate)
    True
    >>> people_match("Fulano de Tal", "Banda X", candidate)
    False
    """
    labels = [set(_person_tokens(label)) for label in candidate.people]
    names = split_composers(composers) + split_composers(performer)
    return any(_same_person(_person_tokens(name), label) for name in names for label in labels)


# --- Wikidata: songs and artists ---


def _spellings(names: Iterable[str]) -> str:
    literals = {
        f'"{_escaped(variant)}"@{language}'
        for name in names
        for variant in title_variants(name)
        for language in ("pt", "en", "mul")
    }
    return " ".join(sorted(literals))


SITELINKS = (
    "  OPTIONAL {{ ?ptw schema:about ?{item}; schema:isPartOf <https://pt.wikipedia.org/>; "
    "schema:name ?pt . }}\n"
    "  OPTIONAL {{ ?enw schema:about ?{item}; schema:isPartOf <https://en.wikipedia.org/>; "
    "schema:name ?en . }}\n"
    "  FILTER(BOUND(?pt) || BOUND(?en))\n"
)


def songs_query(titles: Sequence[str]) -> str:
    """Return the SPARQL query for musical works (albums left out) carrying any of the titles.

    One row per (spelling, work), with the Wikipedia titles and the people labels joined by "|".
    """
    return (
        "SELECT ?name ?song (SAMPLE(?pt) AS ?ptTitle) (SAMPLE(?en) AS ?enTitle)\n"
        '       (GROUP_CONCAT(DISTINCT ?whoLabel; separator="|") AS ?people) WHERE {\n'
        f"  VALUES ?name {{ {_spellings(titles)} }}\n"
        "  ?song rdfs:label|skos:altLabel ?name .\n"
        f"  ?song wdt:P31/wdt:P279* wd:{MUSICAL_WORK} .\n"
        f"  MINUS {{ ?song wdt:P31/wdt:P279* wd:{ALBUM} . }}\n"
        + SITELINKS.format(item="song")
        + "  OPTIONAL { ?song wdt:P86|wdt:P676|wdt:P175|wdt:P50|wdt:P87|wdt:P170 ?who .\n"
        "             ?who rdfs:label ?whoLabel .\n"
        '             FILTER(LANG(?whoLabel) IN ("pt", "en")) }\n'
        "} GROUP BY ?name ?song"
    )


def artists_query(names: Sequence[str]) -> str:
    """Return the SPARQL query for musicians and musical ensembles with any of the names."""
    occupations = " ".join(f"wd:{qid}" for qid in sorted(MUSIC_OCCUPATIONS))
    return (
        "SELECT ?name ?who (SAMPLE(?pt) AS ?ptTitle) (SAMPLE(?en) AS ?enTitle) WHERE {\n"
        f"  VALUES ?name {{ {_spellings(names)} }}\n"
        "  ?who rdfs:label|skos:altLabel ?name .\n"
        f"  {{ ?who wdt:P31 wd:Q5 . ?who wdt:P106 ?occupation . VALUES ?occupation "
        f"{{ {occupations} }} }}\n"
        f"  UNION {{ ?who wdt:P31/wdt:P279* wd:{MUSICAL_ENSEMBLE} . }}\n"
        + SITELINKS.format(item="who")
        + "} GROUP BY ?name ?who"
    )


def _cache_file(cache_dir: Path, kind: str, key: str) -> Path:
    return cache_dir / kind / f"{hashlib.sha1(key.encode()).hexdigest()[:24]}.json"


def _read_cache(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write_cache(path: Path, answer: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + ".part")  # an interrupted run never leaves half a file
    partial.write_text(json.dumps(answer, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    partial.replace(path)


def _qid(url: str) -> str:
    return url.removeprefix(ENTITY_PREFIX)


def _batch_rows(
    texts: Sequence[str],
    query_for: Callable[[Sequence[str]], str],
    fetch: Fetch,
    sleep: Callable[[float], None],
    retry: bool = True,
) -> list[dict]:
    """Query a batch; when the service keeps timing out, split it in halves (a heavy query).

    A name like "Alex" has so many namesakes that one query holding it can exceed the service's
    time limit. The halves are tried once each (the failure is not a passing glitch), down to a
    single text; a single text that still fails is too ambiguous to match safely, so it
    answers "nothing found".
    """
    try:
        if retry:
            return _fetch_with_retries(query_for(texts), fetch, sleep)["results"]["bindings"]
        return fetch(query_for(texts))["results"]["bindings"]
    except (OSError, ValueError):
        if len(texts) == 1:
            return []
        middle = len(texts) // 2
        first = _batch_rows(texts[:middle], query_for, fetch, sleep, retry=False)
        sleep(MINIMUM_DELAY_SECONDS)
        return first + _batch_rows(texts[middle:], query_for, fetch, sleep, retry=False)


def _batched_lookup(
    texts: Iterable[str],
    kind: str,
    cache_dir: Path | str,
    query_for: Callable[[Sequence[str]], str],
    candidates_of: Callable[[list[dict]], list[dict]],
    batch_size: int,
    fetch: Fetch,
    sleep: Callable[[float], None],
    today: str | None,
    log: Callable[[str], None],
) -> dict[str, list[dict]]:
    """Ask Wikidata about each distinct `title_key` once, a batch at a time, caching the answers.

    Returns {key: candidate dicts} for every key; `candidates_of` turns the rows of one key into
    the dicts that are cached (an empty list means "asked, nobody knows it").
    """
    cache_dir = Path(cache_dir)
    first_text: dict[str, str] = {}
    for text in texts:
        key = title_key(text)
        if key:
            first_text.setdefault(key, text)
    answers = {key: _read_cache(_cache_file(cache_dir, kind, key)) for key in first_text}
    missing = [key for key, answer in answers.items() if answer is None]
    checked = today or date.today().isoformat()
    for start in range(0, len(missing), batch_size):
        batch = missing[start : start + batch_size]
        if start > 0:
            sleep(MINIMUM_DELAY_SECONDS)
        rows = _batch_rows([first_text[key] for key in batch], query_for, fetch, sleep)
        for key in batch:
            matching = [row for row in rows if title_key(row["name"]["value"]) == key]
            answer = {"key": key, "checked": checked, "candidates": candidates_of(matching)}
            _write_cache(_cache_file(cache_dir, kind, key), answer)
            answers[key] = answer
        log(f"{kind}: {min(start + batch_size, len(missing))}/{len(missing)} queried")
    return {key: answer["candidates"] for key, answer in answers.items()}


def _song_candidates(rows: list[dict]) -> list[dict]:
    merged: dict[str, dict] = {}
    for row in rows:
        qid = _qid(row["song"]["value"])
        item = merged.setdefault(
            qid,
            {
                "qid": qid,
                "pt": row.get("ptTitle", {}).get("value"),
                "en": row.get("enTitle", {}).get("value"),
                "people": [],
            },
        )
        for person in row.get("people", {}).get("value", "").split("|"):
            if person and person not in item["people"]:
                item["people"].append(person)
    return list(merged.values())


def resolve_songs(
    titles: Iterable[str],
    cache_dir: Path | str,
    fetch: Fetch = post_sparql,
    sleep: Callable[[float], None] = time.sleep,
    today: str | None = None,
    log: Callable[[str], None] = print,
) -> dict[str, list[SongCandidate]]:
    """Find the Wikidata musical works with a Wikipedia article for each title.

    Args:
        titles: song titles, in any letter case; repeats (by `title_key`) are asked once.
        cache_dir: the popularity cache folder; titles already answered there are not asked.
        fetch: sends a SPARQL query and returns the JSON results.
        sleep: waits a number of seconds (one second between two queries).
        today: the date recorded for new answers (default: today).
        log: prints one progress line.

    Returns:
        {title_key: candidates}; an empty list when no musical work carries that title.
    """
    found = _batched_lookup(
        titles, "songs", cache_dir, songs_query, _song_candidates, SONG_BATCH_SIZE,
        fetch, sleep, today, log,
    )  # fmt: skip
    return {
        key: [
            SongCandidate(item["qid"], item["pt"], item["en"], tuple(item["people"]))
            for item in items
        ]
        for key, items in found.items()
    }


def _artist_candidates(rows: list[dict]) -> list[dict]:
    merged = {}
    for row in rows:
        qid = _qid(row["who"]["value"])
        merged[qid] = {
            "qid": qid,
            "pt": row.get("ptTitle", {}).get("value"),
            "en": row.get("enTitle", {}).get("value"),
        }
    return list(merged.values())


def resolve_artists(
    names: Iterable[str],
    cache_dir: Path | str,
    fetch: Fetch = post_sparql,
    sleep: Callable[[float], None] = time.sleep,
    today: str | None = None,
    log: Callable[[str], None] = print,
) -> dict[str, tuple[str | None, str | None]]:
    """Find the Wikipedia articles (pt, en titles) of musicians and ensembles by exact name.

    A name that two or more musicians share, or that nobody with an article carries, is left
    out: guessing would give a song the page views of a stranger.
    """
    names = list(dict.fromkeys(names))
    found = _batched_lookup(
        names, "artists", cache_dir, artists_query, _artist_candidates, BATCH_SIZE,
        fetch, sleep, today, log,
    )  # fmt: skip
    resolved = {}
    for name in names:
        candidates = found.get(title_key(name), [])
        if len(candidates) == 1:
            resolved[name] = (candidates[0]["pt"], candidates[0]["en"])
    return resolved


# --- Wikipedia page views ---


def views_period(today: date) -> tuple[str, str]:
    """Return the (start, end) timestamps of the last 12 full months, as the API writes them.

    >>> views_period(date(2026, 10, 21))
    ('2025100100', '2026093000')
    """
    last_day = today.replace(day=1) - timedelta(days=1)
    months = last_day.year * 12 + last_day.month - 1 - 11  # the month 11 before the last one
    first_month = date(months // 12, months % 12 + 1, 1)
    return first_month.strftime("%Y%m0100"), last_day.strftime("%Y%m%d00")


def fetch_pageviews(
    url: str,
    opener: Callable = urllib.request.urlopen,
    sleep: Callable[[float], None] = time.sleep,
) -> dict | None:
    """GET a pageviews URL as JSON; None when the article has no data (HTTP 404).

    A busy service (429, 5xx) or a dropped connection is retried after a growing pause.
    """
    request = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"}
    )
    for attempt in range(1, PAGEVIEWS_RETRIES + 1):
        try:
            with opener(request, timeout=PAGEVIEWS_TIMEOUT_SECONDS) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            failure = error
        except (OSError, ValueError) as error:  # timeouts, resets, broken JSON
            failure = error
        if attempt == PAGEVIEWS_RETRIES:
            raise ValueError(
                f"the pageviews request failed {attempt} times: {failure}"
            ) from failure
        sleep(PAGEVIEWS_RETRY_PAUSE_SECONDS * attempt)
    raise AssertionError("unreachable")


def article_views(
    project: str,
    article: str,
    cache_dir: Path | str,
    fetch: PageviewsFetch,
    sleep: Callable[[float], None] = time.sleep,
    today: date | None = None,
    delay: float = PAGEVIEWS_DELAY_SECONDS,
) -> int:
    """Return an article's reader count over the last 12 full months (0 when it has no data).

    Args:
        project: "pt" or "en" (the Wikipedia language).
        article: the article title, with spaces or underscores.
        cache_dir: the popularity cache folder; an answer for the same period is not asked again.
        fetch: GETs a URL and returns its JSON (None for 404).
        sleep: waits a number of seconds; called with `delay` before every request sent.
        today: the date the period is counted back from (default: today).
        delay: seconds between two requests (at least 0.2: five requests per second at most).
    """
    if delay < PAGEVIEWS_DELAY_SECONDS:
        raise ValueError(f"the delay must be at least {PAGEVIEWS_DELAY_SECONDS} s, got {delay}")
    start, end = views_period(today or date.today())
    title = article.replace(" ", "_")
    path = _cache_file(Path(cache_dir), f"views-{project}", title)
    cached = _read_cache(path)
    if cached and (cached.get("start"), cached.get("end")) == (start, end):
        return cached["views"]
    sleep(delay)
    url = PAGEVIEWS_URL.format(
        project=project, article=urllib.parse.quote(title, safe=""), start=start, end=end
    )
    answer = fetch(url)
    total = sum(item["views"] for item in answer["items"]) if answer else 0
    _write_cache(
        path, {"project": project, "article": title, "start": start, "end": end, "views": total}
    )
    return total


# --- Wikipedia popularity of MPB and public-domain songs ---


@dataclass(frozen=True)
class WikipediaPopularity:
    """How each entry's `pop` was found: the numbers and how many came from where."""

    pops: list[int]
    matched: int  # entries matched to a song article
    from_artist: int  # entries that took their artist's page views
    unknown: int  # entries with neither


def wikipedia_popularity(
    entries: Sequence[Mapping],
    cache_dir: Path | str,
    fetch_sparql: Fetch = post_sparql,
    fetch_views: PageviewsFetch = fetch_pageviews,
    sleep: Callable[[float], None] = time.sleep,
    today: date | None = None,
    log: Callable[[str], None] = print,
) -> WikipediaPopularity:
    """Give each entry (fields `t`, `c`, `p`) the popularity described in the module docstring."""
    day = today or date.today()

    def views(project: str, article: str | None) -> int:
        if not article:
            return 0
        return article_views(project, article, cache_dir, fetch_views, sleep, day)

    candidates = resolve_songs(
        (entry["t"] for entry in entries), cache_dir, fetch_sparql, sleep, day.isoformat(), log
    )
    pops: list[int | None] = []
    for index, entry in enumerate(entries):
        matches = [
            candidate
            for candidate in candidates[title_key(entry["t"])]
            if people_match(entry["c"], entry["p"], candidate)
        ]
        pops.append(
            max(views("pt", c.pt_title) + views("en", c.en_title) for c in matches)
            if matches
            else None
        )
        if (index + 1) % 250 == 0:
            log(f"page views: {index + 1}/{len(entries)} songs")
    unmatched = [index for index, pop in enumerate(pops) if pop is None]
    names = [
        name
        for index in unmatched
        for name in split_composers(entries[index]["p"]) + split_composers(entries[index]["c"])
    ]
    artists = resolve_artists(names, cache_dir, fetch_sparql, sleep, day.isoformat(), log)
    from_artist = 0
    for index in unmatched:
        entry = entries[index]
        found = [
            views("pt", artists[name][0]) + views("en", artists[name][1])
            for name in split_composers(entry["p"]) + split_composers(entry["c"])
            if name in artists
        ]
        if found:
            from_artist += 1
        pops[index] = max(found, default=0) // ARTIST_DIVISOR
    return WikipediaPopularity(
        [pop or 0 for pop in pops],
        len(entries) - len(unmatched),
        from_artist,
        len(unmatched) - from_artist,
    )


# --- The other sources ---


def _pdmx_number(value: str | None) -> float:
    try:
        return float(value or "")
    except ValueError:
        return 0.0  # PDMX writes a missing counter as NA


def pdmx_popularity(csv_path: Path | str, entries: Sequence[Mapping]) -> list[int]:
    """Return `(views + 20 * favorites + 50 * ratings * rating / 5) / 5` for each PDMX entry.

    Rows are found by the entry's MIDI path (`facts.midi`, the CSV's `mid` column).
    """
    wanted = {entry["facts"]["midi"] for entry in entries}
    csv.field_size_limit(1 << 24)  # some PDMX rows hold long tag lists
    rows = {}
    with Path(csv_path).open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            midi = (row.get("mid") or "").removeprefix("./")
            if midi in wanted:
                rows[midi] = row
    missing = sorted(wanted - rows.keys())
    if missing:
        raise ValueError(f"{len(missing)} PDMX scores are not in {csv_path}, e.g. {missing[0]}")
    pops = []
    for entry in entries:
        row = rows[entry["facts"]["midi"]]
        engagement = (
            _pdmx_number(row["n_views"])
            + PDMX_FAVORITE_WEIGHT * _pdmx_number(row["n_favorites"])
            + PDMX_RATING_WEIGHT * _pdmx_number(row["n_ratings"]) * _pdmx_number(row["rating"]) / 5
        )
        pops.append(round(engagement / PDMX_ALL_TIME_DIVISOR))
    return pops


def nottingham_popularity(entries: Sequence[Mapping]) -> list[int]:
    """Return the fixed high value for the well-known tunes and 1 for the others."""
    return [
        NOTTINGHAM_FAMOUS_POP if entry["t"].lower() in NOTTINGHAM_FAMOUS else NOTTINGHAM_OTHER_POP
        for entry in entries
    ]


def examples_popularity(entries: Sequence[Mapping]) -> list[int]:
    """Return a value above every other source, falling with the example's curated `order`."""
    return [EXAMPLES_POP_BASE - entry["order"] for entry in entries]


# --- Rewriting the catalog files ---


def with_popularity(entries: Sequence[dict], pops: Sequence[int], source: str) -> list[dict]:
    """Return the entries with `pop` added and, for MPB, the download route.

    An entry keeps every other field, in its order; `pop` goes last (or stays where it was on a
    rerun). An MPB entry's `{"server": ...}` route becomes `{"download": <MIDI link>}`.
    """
    updated = []
    for entry, pop in zip(entries, pops, strict=True):
        fresh = dict(entry)
        if source == "mpb" and "server" in fresh.get("route", {}):
            fresh["route"] = {"download": fresh["facts"]["midi"]}
        fresh["pop"] = int(pop)
        updated.append(fresh)
    return updated


def _read_catalog(path: Path) -> tuple[dict, list[dict]]:
    record = json.loads(path.read_text(encoding="utf-8"))
    return {field: record[field] for field in ENVELOPE_FIELDS}, record["entries"]


def _written(path: Path, envelope: dict, entries: Sequence[dict], pops: Sequence[int]) -> None:
    source = envelope["source"]
    if POPULARITY_COMMAND not in envelope["generated"]:
        envelope = envelope | {"generated": f"{envelope['generated']}; then {POPULARITY_COMMAND}"}
    write_catalog_file(path, envelope, with_popularity(entries, pops, source))


def add_popularity_parser(catalog_commands: argparse._SubParsersAction) -> None:
    """Add `catalog popularity` (contracts/cli.md)."""
    popularity = catalog_commands.add_parser(
        "popularity", help="add `pop` to every catalog entry and set the MPB download routes"
    )
    popularity.add_argument("--catalog-dir", type=Path, default=CATALOG_ROOT)
    popularity.add_argument("--pdmx", type=Path, default=DEFAULT_PDMX, help="PDMX.csv")
    popularity.add_argument(
        "--cache", type=Path, default=DEFAULT_CACHE, help="folder of the Wikidata/Wikipedia answers"
    )
    popularity.set_defaults(handler=run_popularity)


def run_popularity(
    args: argparse.Namespace,
    fetch_sparql: Fetch = post_sparql,
    fetch_views: PageviewsFetch = fetch_pageviews,
    sleep: Callable[[float], None] = time.sleep,
    today: date | None = None,
) -> dict[str, list[int]]:
    """Add `pop` to the five catalog files (see the module docstring); print the counts.

    Returns:
        {source: pop of each entry, in file order}.
    """
    files = {source: args.catalog_dir / f"{source}.json" for source in SOURCES}
    catalogs = {source: _read_catalog(path) for source, path in files.items()}
    pops: dict[str, list[int]] = {}
    pops["examples"] = examples_popularity(catalogs["examples"][1])
    pops["nottingham"] = nottingham_popularity(catalogs["nottingham"][1])
    pops["pdmx"] = pdmx_popularity(args.pdmx, catalogs["pdmx"][1])

    mpb, public = catalogs["mpb"][1], catalogs["public-domain"][1]
    wikipedia = wikipedia_popularity(
        [*mpb, *public], args.cache, fetch_sparql, fetch_views, sleep, today
    )
    pops["mpb"], pops["public-domain"] = wikipedia.pops[: len(mpb)], wikipedia.pops[len(mpb) :]

    for source, path in files.items():
        envelope, entries = catalogs[source]
        _written(path, envelope, entries, pops[source])
    total = len(mpb) + len(public)
    print(
        f"{wikipedia.matched} of {total} MPB and public-domain songs matched a Wikipedia "
        f"article; {wikipedia.from_artist} took their artist's page views, "
        f"{wikipedia.unknown} have no data"
    )
    for source in files:
        print(f"{source}: {len(pops[source])} entries, top pop {max(pops[source], default=0)}")
    return pops
