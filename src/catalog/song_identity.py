"""Who wrote a MIDI file, and what is it called: guesses from the file, checked online.

A folder of MIDI files rarely says what each song is. This module finds a title and a composer
for a file in three steps, and records where each one came from:

1. **Hints in the file.** The file name is the best hint, because whoever named the files meant
   it: "Bach - Air on the G String.mid", "air_on_the_g_string_bach.mid", "Prelude in C by J S
   Bach.mid". A name that says nothing ("track01") is replaced by the sequence name inside the
   MIDI file (the name of its first track). A MIDI file may also carry text events such as
   "Composer: Erik Satie" or the karaoke convention "@TTitle".
2. **A guess.** The name is split into a title and a composer. "Composer - Title" and "Title -
   Composer" are told apart by looking for a well-known composer's name (`KNOWN_COMPOSERS`, a
   hint only); when neither side looks like a composer both orders are kept, "Composer - Title"
   first. Underscores and dashes without spaces are word separators.
3. **MusicBrainz.** The guess is searched as a *work* on MusicBrainz (title and composer). A work
   whose title is almost the same and whose composer is the one guessed confirms the guess
   (confidence "high") and gives the composer's full name ("Bach" becomes "Johann Sebastian
   Bach"). A work that only matches the title fills in a missing composer ("medium"). When
   nothing matches, or the service cannot be reached, the guess stands ("low") and the preview
   marks it, so the student can correct it.

Politeness: the project's User-Agent, and at least one second between requests (MusicBrainz's
rule). Every answer is cached under `data/raw/musicbrainz/` (never committed), so a rerun asks
nothing. Network access happens only in `fetch_musicbrainz`; the tests pass a fake.
"""

import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path

import mido

from catalog.popularity import SongCandidate, people_match, title_key, title_variants
from leadsheet.sources import USER_AGENT

MUSICBRAINZ_URL = "https://musicbrainz.org/ws/2/work/"
WORK_PAGE = "https://musicbrainz.org/work/"
MINIMUM_DELAY_SECONDS = 1.0
SEARCH_LIMIT = 5
TIMEOUT_SECONDS = 30
RETRIES = 4
RETRY_PAUSE_SECONDS = 2.0
TITLE_MATCH = 0.85  # how alike two title keys must be to be the same work
MEDIUM_SCORE = 90  # MusicBrainz's own match score a title-only match needs
COMPOSER_RELATIONS = frozenset({"composer", "writer"})
MAX_HINT_EVENTS = 60

# Surnames (and a few full names) of composers whose name in a file name settles which side is
# the composer. Only a hint for splitting a name; MusicBrainz and Wikidata decide who they are.
_KNOWN_SURNAMES = [
    "Bach",
    "Beethoven",
    "Mozart",
    "Chopin",
    "Schubert",
    "Schumann",
    "Brahms",
    "Haydn",
    "Handel",
    "Vivaldi",
    "Liszt",
    "Debussy",
    "Satie",
    "Ravel",
    "Tchaikovsky",
    "Rachmaninoff",
    "Rachmaninov",
    "Grieg",
    "Dvorak",
    "Mendelssohn",
    "Pachelbel",
    "Joplin",
    "Scarlatti",
    "Paganini",
    "Verdi",
    "Puccini",
    "Rossini",
    "Wagner",
    "Mahler",
    "Bizet",
    "Offenbach",
    "Strauss",
    "Gounod",
    "Faure",
    "Albeniz",
    "Granados",
    "Tarrega",
    "Sor",
    "Nazareth",
    "Gottschalk",
    "Clementi",
    "Czerny",
    "Purcell",
    "Monteverdi",
    "Corelli",
    "Telemann",
    "Albinoni",
    "Boccherini",
    "Gluck",
    "Weber",
    "Sibelius",
    "Elgar",
    "Holst",
    "Borodin",
    "Mussorgsky",
    "Glinka",
    "Prokofiev",
    "Shostakovich",
    "Stravinsky",
    "Scriabin",
    "Bartok",
    "Kodaly",
    "Janacek",
    "Smetana",
    "Berlioz",
    "Franck",
    "Massenet",
    "Delibes",
    "Lully",
    "Rameau",
    "Couperin",
    "Buxtehude",
    "Gershwin",
    "Ellington",
    "Jobim",
    "Pixinguinha",
    "Barroso",
    "Lehar",
    "Khachaturian",
    "Piazzolla",
    "Barrios",
]
_KNOWN_FULL_NAMES = (
    "Saint-Saens",
    "Villa Lobos",
    "Rimsky Korsakov",
    "Chiquinha Gonzaga",
    "Zequinha de Abreu",
    "Ernesto Nazareth",
    "Luiz Gonzaga",
    "Ary Barroso",
    "Tom Jobim",
    "Carlos Gomes",
)
KNOWN_COMPOSERS = frozenset(title_key(name) for name in (*_KNOWN_SURNAMES, *_KNOWN_FULL_NAMES))

SEPARATOR = re.compile(r"\s[-–—]\s+|\s*__+\s*|\s+by\s+", re.IGNORECASE)
LEADING_NUMBER = re.compile(r"^(?:\d{1,3}\s*[-._)]+\s*|0\d\s+)(?=\D)")
BRACKETS = re.compile(r"\s*[\(\[][^\)\]]*[\)\]]\s*")
CATALOG_NUMBER = re.compile(r"\s*\b(?:op|bwv|kv|k|rv|hob|woo|d)\.?\s*\d+[a-z]?\b.*$", re.IGNORECASE)
UPPERCASE_WORDS = {"bwv", "kv", "rv", "hob"}
GENERIC_NAME = re.compile(
    r"^(?:(?:track|song|untitled|unknown|midi|sequence|new|noname|no|name|file|music|piano|"
    r"copy|of|the|\d+)[\s_.\-]*)+$",
    re.IGNORECASE,
)
COMPOSER_LABEL = re.compile(
    r"^(?:composer|composed by|music by|written by|compositor|composto por|musica de|música de)"
    r"\s*[:\-]?\s*(.+)$",
    re.IGNORECASE,
)
TITLE_LABEL = re.compile(r"^(?:title|titre|titulo|título)\s*:\s*(.+)$", re.IGNORECASE)
KARAOKE_TITLE = re.compile(r"^@T(.+)$")

Fetch = Callable[[str], dict]


@dataclass(frozen=True)
class NameGuess:
    """A title and a composer read from a file name.

    Attributes:
        title: the song's title, in title case when the name was all lower or upper case.
        composer: the composer as the name writes it ("Bach"); "" when the name gives none.
    """

    title: str
    composer: str


@dataclass(frozen=True)
class MidiHints:
    """What the inside of a MIDI file says about the song; every field may be empty.

    Attributes:
        sequence_name: the name of the file's first track, when it holds no notes (the
            conductor track) or is the only track.
        title: from a "Title: ..." or karaoke "@T..." text event.
        composer: from a "Composer: ...", "Composed by ..." or "Music by ..." text event.
        copyright: the copyright notice; it names whoever made the sequence, not the composer.
    """

    sequence_name: str = ""
    title: str = ""
    composer: str = ""
    copyright: str = ""


@dataclass(frozen=True)
class Work:
    """One MusicBrainz work from a search.

    Attributes:
        title: the work's title.
        composers: names of the artists related to it as composer or writer.
        score: MusicBrainz's own match score, 0 to 100.
        url: the work's page.
    """

    title: str
    composers: tuple[str, ...]
    score: int
    url: str


@dataclass(frozen=True)
class Identity:
    """The title and composer found for a file, and how sure we are.

    Attributes:
        title, composer: the values to use; composer is "" when none was found.
        title_from, composer_from: where each came from ("file name", "MIDI sequence name",
            "MIDI text event", "MusicBrainz"); composer_from is "" without a composer.
        confidence: "high" (MusicBrainz confirms title and composer), "medium" (it confirms the
            title and supplied the composer) or "low" (a guess nothing confirmed).
        musicbrainz: the matching work's page, "" without a match.
        note: why the confidence is what it is, for the preview.
    """

    title: str
    composer: str
    title_from: str
    composer_from: str
    confidence: str
    musicbrainz: str = ""
    note: str = ""


# --- The file name ---


def _title_case(text: str) -> str:
    """Write an all-lower or all-upper title in title case; keep a mixed-case one as it is.

    >>> _title_case("air on the g string"), _title_case("GymnopÉdie")
    ('Air on the G String', 'GymnopÉdie')
    """
    if not text.strip() or (text != text.lower() and text != text.upper()):
        return text
    words = title_variants(text)[0].split(" ")
    joined = " ".join(word.upper() if word.lower() in UPPERCASE_WORDS else word for word in words)
    return re.sub(r"\bno(?= \d)", "No", joined)  # "no" is a small word, but "No 5" is a number


def normalize_person(name: str) -> str:
    """Return a person's name written plainly: "Surname, Given" turned around, initials spaced.

    >>> normalize_person("Bach, Johann Sebastian"), normalize_person("  j.s.  bach ")
    ('Johann Sebastian Bach', 'J S Bach')
    """
    name = " ".join(name.replace(".", " ").split())
    parts = [part.strip() for part in name.split(",")]
    if len(parts) == 2 and all(parts):
        name = f"{parts[1]} {parts[0]}"
    return _title_case(name) if name == name.lower() or name == name.upper() else name


def _words_of(stem: str) -> str:
    """Turn a file name into spaced words: underscores are spaces, and so are dashes in a name
    that has no spaces ("Minuet-in-G")."""
    text = stem.replace("_", " ")
    if " " not in text.strip():
        text = text.replace("-", " ")
    return " ".join(text.split())


def _looks_like_composer(text: str) -> bool:
    keys = title_key(text).split()
    return any(
        " ".join(keys[i : i + n]) in KNOWN_COMPOSERS for n in (3, 2, 1) for i in range(len(keys))
    )


def _edge_composer(words: list[str]) -> tuple[str, str] | None:
    """Find a known composer at the start or the end of a list of words: (title, composer)."""
    for n in (3, 2, 1):
        if len(words) > n and title_key(" ".join(words[:n])) in KNOWN_COMPOSERS:
            return " ".join(words[n:]), " ".join(words[:n])
        if len(words) > n and title_key(" ".join(words[-n:])) in KNOWN_COMPOSERS:
            return " ".join(words[:-n]), " ".join(words[-n:])
    return None


def is_generic_title(stem: str) -> bool:
    """Say whether a file name says nothing about the song ("track01", "untitled", "01").

    >>> is_generic_title("Track 1"), is_generic_title("track of my heart")
    (True, False)
    """
    return bool(GENERIC_NAME.match(stem.strip()))


def name_guesses(stem: str) -> list[NameGuess]:
    """Read a file name (without extension) as a title and a composer, most likely first.

    >>> name_guesses("Bach - Air on the G String")[0]
    NameGuess(title='Air on the G String', composer='Bach')
    >>> name_guesses("minuet_in_g")
    [NameGuess(title='Minuet in G', composer='')]
    """
    stem = BRACKETS.sub(" ", LEADING_NUMBER.sub("", stem.strip())).strip()
    parts = [part.strip() for part in SEPARATOR.split(stem) if part.strip()]
    separator = SEPARATOR.search(stem)
    by_word = bool(separator and separator.group().strip().lower() == "by")

    def guess(title: str, composer: str) -> NameGuess:
        return NameGuess(_title_case(_words_of(title)), normalize_person(_words_of(composer)))

    if len(parts) == 2:
        first, second = parts
        if by_word:
            return [guess(first, second)]
        first_is, second_is = _looks_like_composer(first), _looks_like_composer(second)
        if first_is and not second_is:
            return [guess(second, first)]
        if second_is and not first_is:
            return [guess(first, second)]
        return [guess(second, first), guess(first, second)]
    words = _words_of(stem).split(" ")
    edge = _edge_composer(words) if len(words) > 1 else None
    if edge:
        return [guess(*edge)]
    return [guess(_words_of(stem), "")]


# --- The hints inside the file ---


def midi_hints(path: Path | str) -> MidiHints:
    """Read the hints a MIDI file carries; an unreadable file gives none."""
    try:
        file = mido.MidiFile(str(path))
    except Exception:  # mido raises many kinds on a damaged file
        return MidiHints()
    hints = {"sequence_name": "", "title": "", "composer": "", "copyright": ""}
    if file.tracks:
        first = file.tracks[0]
        has_notes = any(message.type == "note_on" for message in first)
        if not has_notes or len(file.tracks) == 1:
            hints["sequence_name"] = next(
                (message.name.strip() for message in first if message.type == "track_name"), ""
            )
    seen = 0
    for track in file.tracks:
        for message in track:
            if message.type not in ("text", "copyright"):
                continue
            seen += 1
            if seen > MAX_HINT_EVENTS:
                break
            text = message.text.strip()
            if message.type == "copyright":
                hints["copyright"] = hints["copyright"] or text
            elif not hints["composer"] and (found := COMPOSER_LABEL.match(text)):
                hints["composer"] = normalize_person(found.group(1).strip())
            elif not hints["title"] and (
                found := TITLE_LABEL.match(text) or KARAOKE_TITLE.match(text)
            ):
                hints["title"] = found.group(1).strip()
    return MidiHints(**hints)


# --- MusicBrainz ---


def musicbrainz_url(title: str, composer: str) -> str:
    """Return the work-search URL for a title and, when known, a composer (Lucene syntax).

    >>> musicbrainz_url("Air", "Bach").startswith("https://musicbrainz.org/ws/2/work/?query=")
    True
    """

    def quoted(text: str) -> str:
        return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'

    query = f"work:{quoted(title)}"
    if composer:
        query += f" AND artist:{quoted(composer)}"
    params = urllib.parse.urlencode({"query": query, "fmt": "json", "limit": SEARCH_LIMIT})
    return f"{MUSICBRAINZ_URL}?{params}"


def fetch_musicbrainz(
    url: str,
    opener: Callable = urllib.request.urlopen,
    sleep: Callable[[float], None] = time.sleep,
) -> dict:
    """GET a MusicBrainz URL as JSON, with the project's User-Agent.

    A busy service (HTTP 429 or 5xx) is asked again after a growing pause, up to four requests;
    the last error is raised.

    Raises:
        OSError: (urllib's HTTPError or URLError) when the service stays unavailable.
    """
    request = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"}
    )
    for attempt in range(1, RETRIES + 1):
        try:
            with opener(request, timeout=TIMEOUT_SECONDS) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            if attempt == RETRIES or error.code not in (429, 500, 502, 503, 504):
                raise
        sleep(RETRY_PAUSE_SECONDS * attempt)
    raise AssertionError("unreachable")


def _cache_file(cache_dir: Path, url: str) -> Path:
    return cache_dir / f"{hashlib.sha1(url.encode()).hexdigest()[:24]}.json"


def search_works(
    title: str,
    composer: str,
    cache_dir: Path | str,
    fetch: Fetch = fetch_musicbrainz,
    sleep: Callable[[float], None] = time.sleep,
    delay: float = MINIMUM_DELAY_SECONDS,
) -> list[Work]:
    """Search MusicBrainz for works with this title (and composer), best match first.

    Args:
        title, composer: what to look for; an empty composer searches by title alone.
        cache_dir: folder of the cached answers; a search asked before is not sent again.
        fetch: GETs a URL and returns its JSON.
        sleep: waits a number of seconds; called with `delay` before every request sent.
        delay: seconds between requests (at least 1.0, MusicBrainz's rule).

    Raises:
        ValueError: when the delay is under a second.
        OSError: when the service cannot be reached (the caller keeps its guess).
    """
    if delay < MINIMUM_DELAY_SECONDS:
        raise ValueError(f"the delay must be at least {MINIMUM_DELAY_SECONDS} s, got {delay}")
    url = musicbrainz_url(title, composer)
    path = _cache_file(Path(cache_dir), url)
    if path.exists():
        answer = json.loads(path.read_text(encoding="utf-8"))
    else:
        sleep(delay)
        answer = fetch(url)
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_name(path.name + ".part")
        partial.write_text(json.dumps(answer, ensure_ascii=False), encoding="utf-8")
        partial.replace(path)
    works = []
    for item in answer.get("works", []):
        composers = tuple(
            relation["artist"]["name"]
            for relation in item.get("relations", [])
            if relation.get("type") in COMPOSER_RELATIONS and "artist" in relation
        )
        works.append(
            Work(
                item.get("title", ""), composers, int(item.get("score", 0)), WORK_PAGE + item["id"]
            )
        )
    return works


# --- Putting it together ---


@dataclass(frozen=True)
class _Candidate:
    title: str
    composer: str
    title_from: str
    composer_from: str


def _without_catalog_number(title: str) -> str:
    """Drop "BWV 565" or "Op. 9 No. 2" from a title: works are listed without them."""
    return CATALOG_NUMBER.sub("", title).strip() or title


def _candidates(path: Path) -> list[_Candidate]:
    hints = midi_hints(path)
    stem = path.stem
    if is_generic_title(stem):
        named = hints.title or (
            hints.sequence_name if not is_generic_title(hints.sequence_name) else ""
        )
        if named:
            source = "MIDI sequence name" if not hints.title else "MIDI text event"
            guesses = [NameGuess(_title_case(named), "")]
        else:
            source, guesses = "file name", [NameGuess(_title_case(_words_of(stem)), "")]
    else:
        source, guesses = "file name", name_guesses(stem)
    candidates = []
    for guess in guesses:
        if guess.composer:
            candidates.append(_Candidate(guess.title, guess.composer, source, "file name"))
        elif hints.composer:
            candidates.append(_Candidate(guess.title, hints.composer, source, "MIDI text event"))
        else:
            candidates.append(_Candidate(guess.title, "", source, ""))
    return candidates


def _same_title(first: str, second: str) -> bool:
    return SequenceMatcher(None, title_key(first), title_key(second)).ratio() >= TITLE_MATCH


def _confirmed_by(guess: str, works: list[Work]) -> tuple[Work, list[str]] | None:
    """Find the first work that lists a composer the guess names; return it and those composers.

    "Bach" is confirmed by a work whose composers include "Johann Sebastian Bach", and only that
    composer is kept: a work also lists arrangers and co-writers who are not the guess.
    """
    for work in works:
        known = [
            composer
            for composer in work.composers
            if people_match(guess, "", SongCandidate("", None, None, (composer,)))
        ]
        if known:
            return work, known
    return None


def _composer_most_works_agree_on(works: list[Work]) -> tuple[Work, str] | None:
    """Pick the composer named by most of the well-scored works with this title.

    MusicBrainz often lists several works under one title, each with its composers (and an
    arranger or two). The composer they share is the one the title is known by; a tie goes to
    the first work in MusicBrainz's order.
    """
    scored = [work for work in works if work.composers and work.score >= MEDIUM_SCORE]
    counts: dict[str, int] = {}
    for work in scored:
        for composer in dict.fromkeys(work.composers):
            counts[composer] = counts.get(composer, 0) + 1
    if not counts:
        return None
    best = max(counts, key=lambda composer: counts[composer])  # max keeps the first on a tie
    return next(work for work in scored if best in work.composers), best


def identify_song(
    path: Path | str,
    cache_dir: Path | str,
    fetch: Fetch = fetch_musicbrainz,
    sleep: Callable[[float], None] = time.sleep,
) -> Identity:
    """Find the title and composer of a MIDI file (see the module docstring).

    Args:
        path: the MIDI file.
        cache_dir: the MusicBrainz cache folder (`data/raw/musicbrainz`).
        fetch, sleep: the network and the clock, replaced by fakes in tests.
    """
    path = Path(path)
    candidates = _candidates(path)
    note = ""
    for candidate in candidates:
        try:
            works = search_works(
                _without_catalog_number(candidate.title),
                candidate.composer,
                cache_dir,
                fetch,
                sleep,
            )
        except (OSError, ValueError):
            note = "MusicBrainz could not be reached; the guess from the file stands"
            break
        matching = [
            work
            for work in works
            if _same_title(_without_catalog_number(candidate.title), work.title)
        ]
        if candidate.composer:
            confirmed = _confirmed_by(candidate.composer, matching)
            if confirmed:
                work, composers = confirmed
                return Identity(
                    candidate.title,
                    ", ".join(composers),
                    candidate.title_from,
                    "MusicBrainz",
                    "high",
                    work.url,
                    "MusicBrainz lists this work by this composer",
                )
        else:
            agreed = _composer_most_works_agree_on(matching)
            if agreed:
                work, composer = agreed
                return Identity(
                    candidate.title,
                    composer,
                    candidate.title_from,
                    "MusicBrainz",
                    "medium",
                    work.url,
                    "the title matches a MusicBrainz work; its composer was taken from there",
                )
    first = candidates[0]
    return Identity(
        first.title,
        first.composer,
        first.title_from,
        first.composer_from,
        "low",
        "",
        note
        or "no MusicBrainz work matches this title and composer; the guess from the file stands",
    )
