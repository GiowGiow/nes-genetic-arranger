"""Who wrote a song, and when they died: the public-domain rule (research R11).

The repository may hold the notes of a song only when the composition is in the public domain
(constitution, "Third-party material"). Brazilian law (Lei 9.610/98, art. 41) protects a work for
the author's life plus 70 years, counted from the January 1st after the death. So in 2026 a song
is free when **every** listed author died in 1955 or earlier.

Death years come from Wikidata, a recorded source anyone can check:

1. A composer string is split into names on ", " and " e " (and the English " and ", " & " and
   " / "), so "Benedito Lacerda, Nelson Angelo e Pixinguinha" gives three names.
2. Each name is matched against *humans* (`wdt:P31 wd:Q5`) whose Portuguese or English label or
   alias is exactly that name. When some matches made music (a music occupation such as
   composer or singer), only those are kept: "Garoto" the guitarist, not a footballer.
3. A name with no match, or with matches that disagree on the death year, or whose person died
   on an unknown date, is **unknown**, and unknown never counts as free. A match with no death
   date is **alive**.

Queries go in batches of 50 names (`VALUES`), at least one second apart, with the project's
User-Agent. Each name's answer is cached in `data/raw/wikidata/` (never committed), with the date
of the query, so a rerun touches no network and writes the same `data/catalog/authors.json`.
Network access happens only in `post_sparql`; the tests pass a fake endpoint.
"""

import argparse
import hashlib
import json
import re
import time
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path

from leadsheet.sources import USER_AGENT

SPARQL_ENDPOINT = "https://query.wikidata.org/sparql"
WIKIDATA_PAGE = "https://www.wikidata.org/wiki/"
ENTITY_PREFIX = "http://www.wikidata.org/entity/"
BATCH_SIZE = 50
MINIMUM_DELAY_SECONDS = 1.0
QUERY_TIMEOUT_SECONDS = 90
RETRIES = 3
RETRY_PAUSE_SECONDS = 10.0
PROTECTION_YEARS = 70  # life + 70 full years (Lei 9.610/98, art. 41)
CURRENT_YEAR = 2026
DEFAULT_AUTHORS = Path("data/catalog/authors.json")
DEFAULT_CACHE = Path("data/raw/wikidata")

# Separators between names in a composer string: Portuguese "e", English "and", "&" and "/".
NAME_SEPARATORS = re.compile(r",\s+| e | and | & | / ")
# Life dates after a name, as some score sites write it: "W. A. Mozart (1756-1791)".
LIFE_DATES = re.compile(r"\s*\([^)]*\d{3,4}[^)]*\)")
# Occupations (Wikidata items) that mark a person who made music; used only to prefer such
# matches when several people share a name.
MUSIC_OCCUPATIONS = frozenset(
    {
        "Q639669",  # musician
        "Q36834",  # composer
        "Q177220",  # singer
        "Q753110",  # songwriter
        "Q488205",  # singer-songwriter
        "Q822146",  # lyricist
        "Q855091",  # guitarist
        "Q486748",  # pianist
        "Q158852",  # conductor
        "Q1259917",  # violinist
        "Q12800682",  # saxophonist
        "Q386854",  # drummer
        "Q1278335",  # instrumentalist
        "Q183945",  # record producer
        "Q806349",  # bandleader
        "Q1198887",  # music director
        "Q16031530",  # music theorist
    }
)

Fetch = Callable[[str], dict]


@dataclass(frozen=True)
class AuthorRecord:
    """One author name and what Wikidata says about it (data-model.md, "Author record").

    Attributes:
        name: the name as the source writes it, e.g. "Ernesto Nazareth".
        qid: the matched Wikidata item, e.g. "Q982541"; None when no single person matched.
        death_year: the year of death; None when alive or unknown.
        status: "dead", "alive" or "unknown".
        source: the item's page, or the SPARQL endpoint when nothing matched.
        checked: the date of the query, as an ISO date.
    """

    name: str
    qid: str | None
    death_year: int | None
    status: str
    source: str
    checked: str


def split_composers(text: str) -> list[str]:
    """Split a composer string into names, dropping blanks and repeats.

    >>> split_composers("Benedito Lacerda, Nelson Angelo e Pixinguinha")
    ['Benedito Lacerda', 'Nelson Angelo', 'Pixinguinha']
    """
    names = []
    for name in NAME_SEPARATORS.split(text.strip()):
        name = " ".join(LIFE_DATES.sub("", name).split())
        if name and name not in names:
            names.append(name)
    return names


def public_domain_limit(year: int = CURRENT_YEAR) -> int:
    """Return the latest death year whose works are free in `year` (life + 70 full years).

    >>> public_domain_limit(2026)
    1955
    """
    return year - PROTECTION_YEARS - 1


def is_public_domain(authors: Sequence[AuthorRecord], year: int = CURRENT_YEAR) -> bool:
    """Return True when there are authors and every one died in `public_domain_limit(year)` or
    earlier; an alive or unknown author keeps the work protected.

    >>> nazareth = AuthorRecord("Ernesto Nazareth", "Q1", 1934, "dead", "", "2026-10-20")
    >>> is_public_domain([nazareth]), is_public_domain([nazareth], year=2004)
    (True, False)
    """
    limit = public_domain_limit(year)
    return bool(authors) and all(
        author.status == "dead" and author.death_year is not None and author.death_year <= limit
        for author in authors
    )


def song_is_public_domain(
    composers: str, authors: Mapping[str, AuthorRecord], year: int = CURRENT_YEAR
) -> bool:
    """Return True when every name of a composer string is resolved and free.

    A name missing from `authors` (never looked up) counts as unknown.
    """
    names = split_composers(composers)
    if not names or any(name not in authors for name in names):
        return False
    return is_public_domain([authors[name] for name in names], year)


def sparql_query(names: Sequence[str]) -> str:
    """Return the SPARQL query that matches each name against humans' pt/en labels and aliases.

    One row per (name, person, death date, occupation); the decision is made in Python.
    """
    literals = " ".join(
        f'"{_escaped(name)}"@{language}' for name in names for language in ("pt", "en")
    )
    return (
        "SELECT ?name ?person ?death ?occupation WHERE {\n"
        f"  VALUES ?name {{ {literals} }}\n"
        "  ?person rdfs:label|skos:altLabel ?name .\n"
        "  ?person wdt:P31 wd:Q5 .\n"
        "  OPTIONAL { ?person wdt:P570 ?death . }\n"
        "  OPTIONAL { ?person wdt:P106 ?occupation . }\n"
        "}"
    )


def post_sparql(query: str, opener: Callable = urllib.request.urlopen) -> dict:
    """Send one query to the Wikidata Query Service and return its JSON results."""
    body = urllib.parse.urlencode({"query": query, "format": "json"}).encode()
    request = urllib.request.Request(
        SPARQL_ENDPOINT,
        data=body,
        headers={"User-Agent": USER_AGENT, "Accept": "application/sparql-results+json"},
    )
    with opener(request, timeout=QUERY_TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode("utf-8"))


def resolve_names(
    names: Iterable[str],
    cache_dir: Path | str,
    fetch: Fetch = post_sparql,
    sleep: Callable[[float], None] = time.sleep,
    today: str | None = None,
    delay: float = MINIMUM_DELAY_SECONDS,
    log: Callable[[str], None] = print,
    pause_first: bool = False,
) -> list[AuthorRecord]:
    """Resolve each name (see the module docstring), querying only names missing from the cache.

    Args:
        names: author names; repeats are resolved once.
        cache_dir: folder of the per-name cache files.
        fetch: function that sends a SPARQL query and returns the JSON results.
        sleep: function that waits a number of seconds.
        today: the date recorded for new queries (default: today).
        delay: seconds between two queries (at least 1.0).
        log: function that prints one progress line.
        pause_first: wait `delay` before the first query too, for a caller that queried just
            before (the PDMX walk calls this once per batch).

    Returns:
        One record per distinct name, in the order of `names`.
    """
    if delay < MINIMUM_DELAY_SECONDS:
        raise ValueError(f"the delay must be at least {MINIMUM_DELAY_SECONDS} s, got {delay}")
    cache_dir = Path(cache_dir)
    unique = list(dict.fromkeys(names))
    answers = {name: _cached(cache_dir, name) for name in unique}
    missing = sorted(name for name, answer in answers.items() if answer is None)
    checked = today or date.today().isoformat()
    for start in range(0, len(missing), BATCH_SIZE):
        batch = missing[start : start + BATCH_SIZE]
        if start > 0 or pause_first:
            sleep(delay)
        rows = _fetch_with_retries(sparql_query(batch), fetch, sleep)["results"]["bindings"]
        for name in batch:
            answer = {
                "name": name,
                "checked": checked,
                "bindings": [row for row in rows if row["name"]["value"] == name],
            }
            _store(cache_dir, answer)
            answers[name] = answer
        log(f"{min(start + BATCH_SIZE, len(missing))}/{len(missing)} names queried")
    return [_decide(answers[name]) for name in unique]


def write_authors(records: Iterable[AuthorRecord], path: Path | str) -> Path:
    """Write `authors.json`: the rule, its source, and one record per line sorted by name."""
    ordered = sorted(records, key=lambda record: record.name)
    header = {
        "about": "Death years of the catalog's authors, from Wikidata (research R11). A song is "
        f"public domain in {CURRENT_YEAR} when every author died in "
        f"{public_domain_limit()} or earlier; unknown counts as not public domain.",
        "source": SPARQL_ENDPOINT,
        "generated": "uv run src/main.py catalog authors",
    }
    fields = [f"  {json.dumps(key)}: {json.dumps(value)}" for key, value in header.items()]
    lines = [
        "    " + json.dumps(asdict(record), ensure_ascii=False, separators=(",", ":"))
        for record in ordered
    ]
    text = "{\n" + ",\n".join(fields) + ',\n  "authors": [\n' + ",\n".join(lines) + "\n  ]\n}\n"
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def read_authors(path: Path | str) -> dict[str, AuthorRecord]:
    """Read `authors.json` into {name: record}."""
    stored = json.loads(Path(path).read_text(encoding="utf-8"))
    return {author["name"]: AuthorRecord(**author) for author in stored["authors"]}


def read_card_composers(*catalog_paths: Path | str) -> list[str]:
    """Return the author names of the catalog files that exist, in file and entry order.

    The MPB songs are split between two cards (`mpb.json`, and `public-domain.json` once their
    authors are known), so the authors command reads both.
    """
    names = []
    for path in map(Path, catalog_paths):
        if path.exists():
            catalog = json.loads(path.read_text(encoding="utf-8"))
            names += [name for entry in catalog["entries"] for name in split_composers(entry["c"])]
    return names


def death_year_of(value: str) -> int | None:
    """Return the year of a Wikidata date literal; None when it is not one.

    >>> death_year_of("1934-02-01T00:00:00Z"), death_year_of("-0500-01-01T00:00:00Z")
    (1934, -500)
    """
    found = re.match(r"^(-?\d+)-\d\d-\d\dT", value)
    return int(found.group(1)) if found else None


def _decide(answer: dict) -> AuthorRecord:
    """Turn the cached rows of one name into a record (rules in the module docstring)."""
    people: dict[str, dict] = {}
    for row in answer["bindings"]:
        qid = row["person"]["value"].removeprefix(ENTITY_PREFIX)
        person = people.setdefault(qid, {"years": set(), "unknown": False, "jobs": set()})
        death = row.get("death")
        if death is not None:
            year = death_year_of(death["value"]) if death.get("type") == "literal" else None
            if year is None:
                person["unknown"] = True
            else:
                person["years"].add(year)
        if "occupation" in row:
            person["jobs"].add(row["occupation"]["value"].removeprefix(ENTITY_PREFIX))
    musicians = [qid for qid, person in people.items() if person["jobs"] & MUSIC_OCCUPATIONS]
    pool = sorted(musicians or people, key=lambda qid: int(qid[1:]) if qid[1:].isdigit() else 0)
    # A person with several death dates (sources disagree) gets the latest: the cautious choice.
    outcomes = {
        max(people[qid]["years"])
        if people[qid]["years"]
        else ("unknown" if people[qid]["unknown"] else None)
        for qid in pool
    }
    name, checked = answer["name"], answer["checked"]
    if len(outcomes) != 1:
        return AuthorRecord(name, None, None, "unknown", SPARQL_ENDPOINT, checked)
    (outcome,) = outcomes
    qid = pool[0]
    if outcome == "unknown":
        return AuthorRecord(name, qid, None, "unknown", WIKIDATA_PAGE + qid, checked)
    if outcome is None:
        return AuthorRecord(name, qid, None, "alive", WIKIDATA_PAGE + qid, checked)
    return AuthorRecord(name, qid, outcome, "dead", WIKIDATA_PAGE + qid, checked)


def _escaped(name: str) -> str:
    return name.replace("\\", "\\\\").replace('"', '\\"')


def _cache_file(cache_dir: Path, name: str) -> Path:
    digest = hashlib.sha256(name.encode("utf-8")).hexdigest()[:24]
    return cache_dir / "names" / f"{digest}.json"


def _cached(cache_dir: Path, name: str) -> dict | None:
    path = _cache_file(cache_dir, name)
    if not path.exists():
        return None
    answer = json.loads(path.read_text(encoding="utf-8"))
    return answer if answer.get("name") == name else None


def _store(cache_dir: Path, answer: dict) -> None:
    path = _cache_file(cache_dir, answer["name"])
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + ".part")
    partial.write_text(json.dumps(answer, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    partial.replace(path)


def _fetch_with_retries(query: str, fetch: Fetch, sleep: Callable[[float], None]) -> dict:
    """Send a query, retrying a failed one (busy service, timeout) after a longer pause."""
    for attempt in range(1, RETRIES + 1):
        try:
            return fetch(query)
        except (OSError, ValueError) as error:  # urllib errors, timeouts, broken JSON
            if attempt == RETRIES:
                raise ValueError(f"the Wikidata query failed {RETRIES} times: {error}") from error
            sleep(RETRY_PAUSE_SECONDS * attempt)
    raise AssertionError("unreachable")


def add_authors_parser(catalog_commands: argparse._SubParsersAction) -> None:
    """Add `catalog authors` (contracts/cli.md)."""
    authors = catalog_commands.add_parser(
        "authors", help="resolve the catalog authors' death years on Wikidata"
    )
    authors.add_argument("--out", type=Path, default=DEFAULT_AUTHORS, help="authors file")
    authors.add_argument("--cache", type=Path, default=DEFAULT_CACHE, help="SPARQL answers")
    authors.add_argument(
        "--mpb",
        type=Path,
        default=Path("arranger/data/catalog/mpb.json"),
        help="MPB catalog whose composers to resolve",
    )
    authors.add_argument(
        "--public-domain",
        type=Path,
        default=Path("arranger/data/catalog/public-domain.json"),
        help="the public-domain MPB card (its songs left mpb.json)",
    )
    authors.add_argument(
        "--pdmx",
        type=Path,
        default=Path("data/raw/pdmx/PDMX.csv"),
        help="PDMX metadata (skipped when missing)",
    )
    authors.add_argument(
        "--pdmx-limit", type=int, default=2000, help="PDMX tunes to find (as `catalog pdmx`)"
    )
    authors.add_argument("--delay", type=float, default=MINIMUM_DELAY_SECONDS, metavar="SECONDS")
    authors.set_defaults(handler=run_authors)


def run_authors(
    args: argparse.Namespace,
    fetch: Fetch = post_sparql,
    sleep: Callable[[float], None] = time.sleep,
) -> list[AuthorRecord]:
    """Resolve the MPB composers, then the PDMX composers the `pdmx` command will look at.

    Every MPB name is written, so each MPB decision can be checked. Of the PDMX names (many
    are not names at all: "Composer", "anon.", "Arr. by …"), only the ones Wikidata resolved
    are written; a missing name counts as unknown, so the decisions stay the same.
    """
    from catalog.collections import pdmx_author_names  # collections imports this module

    def resolve(names: Iterable[str], pause_first: bool = False) -> list[AuthorRecord]:
        return resolve_names(
            names, args.cache, fetch, sleep, delay=args.delay, pause_first=pause_first
        )

    mpb_records = {r.name: r for r in resolve(read_card_composers(args.mpb, args.public_domain))}
    records = dict(mpb_records)
    if args.pdmx.exists():
        walk = pdmx_author_names(args.pdmx, args.pdmx_limit, lambda n: resolve(n, True))
        for record in walk:
            if record.status != "unknown" and record.name not in records:
                records[record.name] = record
    write_authors(records.values(), args.out)
    counts = {status: 0 for status in ("dead", "alive", "unknown")}
    for record in mpb_records.values():
        counts[record.status] += 1
    print(
        f"{len(records)} authors ({len(mpb_records)} MPB: {counts['dead']} dead, "
        f"{counts['alive']} alive, {counts['unknown']} unknown)"
    )
    print(args.out)
    return list(records.values())
