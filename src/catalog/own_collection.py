"""Your own MIDI collections: put files in a folder, set one license, and the app lists them.

The student may redistribute some MIDI files: their own work, public-domain compositions that
someone sequenced and released, files under a Creative Commons license. This module turns a
folder of them into a playlist of the app (`kind: local-midi` in the registry), with as little
typing as possible:

1. **One license for the folder.** `--license CC0-1.0 --source https://...` is set once. Only
   licenses that allow redistribution are accepted (`canonical_license`), and a license that asks
   for credit needs a source. A file may override the license in the sidecar.
2. **Everything else is found.** For each file the tool finds the title and the composer from the
   file name and the MIDI text events, confirmed on MusicBrainz (`catalog.song_identity`); the
   composer's death year from Wikidata, which says whether the composition is in the public
   domain (`catalog.authors`); and a popularity from Wikipedia page views (`catalog.popularity`).
   The album defaults to the sub-folder the file sits in, else the composer, so a classical
   folder groups by composer and lists the best-known pieces first.
3. **A public-domain license is checked.** A composition is free only when every composer died
   in 1955 or earlier; with the `public-domain` license, a song whose composer Wikidata does not
   confirm is left out, unless `--include-unconfirmed` is passed or the sidecar says
   `public_domain = true`. Other licenses cover the sequence and are not checked against the
   composer, but the preview still reports the composition's status.
4. **The sidecar is optional.** `collection init` writes `<folder>/collection.toml` with
   everything it found, so a wrong match can be fixed; the file is never required. Without it,
   `collection build` runs the whole lookup. A value written in the sidecar wins over a lookup.

Commands (see `catalog.collection_cli`): `init` writes the sidecar, `preview` prints the
playlist as the app will show it, `build` writes `arranger/data/catalog/<id>.json` and registers
the collection, `remove` (registry) unregisters it. MIDI files are never copied or changed, and
they must lie inside the repository, because GitHub Pages publishes the repository and the app
fetches them from its own site.

Online answers are cached under `data/raw/` (never committed). `--offline` uses the cache only.
"""

import argparse
import json
import re
import time
import tomllib
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path

import pretty_midi

from catalog.analysis import analyze_and_reduce, describe_tracks
from catalog.authors import (
    AuthorRecord,
    is_public_domain,
    namesakes_death_year,
    post_sparql,
    resolve_names,
    split_composers,
)
from catalog.cards import normalized_title, sprite_seed, write_catalog_file
from catalog.popularity import fetch_pageviews, wikipedia_popularity
from catalog.registry import (
    CATALOG_DIR,
    LOCAL_ORDER,
    check_new_id,
    read_registry,
    register,
    slugify,
)
from catalog.song_identity import Identity, fetch_musicbrainz, identify_song

MIDI_SUFFIXES = (".mid", ".midi")
SIDECAR = "collection.toml"
DEFAULT_SORTS = ("order", "title", "popularity")
REPO_HOME = "https://github.com/GiowGiow/nes-genetic-arranger"
MUSICBRAINZ_CACHE = Path("data/raw/musicbrainz")
WIKIDATA_CACHE = Path("data/raw/wikidata")
POPULARITY_CACHE = Path("data/raw/popularity")

# Licenses that allow redistribution, and how each is spelled in the catalog.
FIXED_LICENSES = {
    "public-domain": "public-domain",
    "cc0-1.0": "CC0-1.0",
    "cc0": "CC0-1.0",
    "own-work": "own-work",
    "mit": "MIT",
    "apache-2.0": "Apache-2.0",
    "isc": "ISC",
    "unlicense": "Unlicense",
}
LICENSE_FAMILIES = (  # a version is part of each of these licenses
    re.compile(r"^CC-BY-\d(?:\.\d)?$", re.IGNORECASE),
    re.compile(r"^CC-BY-SA-\d(?:\.\d)?$", re.IGNORECASE),
    re.compile(r"^(?:A|L)?GPL-\d(?:\.\d)?(?:-only|-or-later)?$", re.IGNORECASE),
    re.compile(r"^BSD-[23]-Clause$", re.IGNORECASE),
)
NO_CREDIT_NEEDED = frozenset({"public-domain", "CC0-1.0", "own-work", "Unlicense"})
ALLOWED_LICENSE_HELP = (
    "public-domain, CC0-1.0, own-work, CC-BY-<version> (e.g. CC-BY-4.0), CC-BY-SA-<version>, "
    "GPL/LGPL/AGPL, MIT, Apache-2.0, BSD, ISC, Unlicense. Licenses with NonCommercial (NC) or "
    "NoDerivatives (ND) terms, and 'all rights reserved', do not allow redistribution."
)

COLLECTION_FIELDS = {"id", "name", "description", "order", "default_sort", "license", "source"}
SONG_FIELDS = {
    "file",
    "title",
    "composer",
    "performer",
    "license",
    "source",
    "album",
    "order",
    "popularity",
    "melody_track",
    "bars",
    "public_domain",
    "skip",
}
SONG_FIELD_TYPES: dict[str, tuple[type, ...]] = {
    "order": (int, float),
    "popularity": (int, float),
    "melody_track": (int,),
    "bars": (list,),
    "public_domain": (bool,),
    "skip": (bool,),
}


def canonical_license(text: str) -> str | None:
    """Return the standard spelling of a license that allows redistribution, else None.

    >>> canonical_license("cc-by-4.0"), canonical_license("CC0"), canonical_license("CC-BY-NC-4.0")
    ('CC-BY-4.0', 'CC0-1.0', None)
    """
    key = text.strip()
    if key.casefold() in FIXED_LICENSES:
        return FIXED_LICENSES[key.casefold()]
    if any(pattern.match(key) for pattern in LICENSE_FAMILIES):
        spelled = key.upper()
        for upper, proper in (
            ("-OR-LATER", "-or-later"),
            ("-ONLY", "-only"),
            ("-CLAUSE", "-Clause"),
        ):
            spelled = spelled.replace(upper, proper)
        return spelled
    return None


# --- Online lookups ---


def wikipedia_pops(entries: Sequence[dict], cache_dir: Path) -> list[int]:
    """Return the Wikipedia popularity of song entries (`catalog.popularity`), cached."""
    answer = wikipedia_popularity(
        entries, cache_dir, post_sparql, fetch_pageviews, log=lambda line: None
    )
    return answer.pops


def _offline_fetch(url: str) -> dict:
    raise OSError("offline: only the cached answers are used")


@dataclass
class Lookups:
    """The network and the clock, in one place so the tests can replace them.

    Attributes:
        musicbrainz: GETs a MusicBrainz URL and returns its JSON.
        sparql: sends a Wikidata SPARQL query and returns its JSON results.
        popularity: gives the popularity of song entries (`t`, `c`, `p`); takes a cache folder.
        sleep: waits a number of seconds.
        log: prints one progress line.
    """

    musicbrainz: Callable[[str], dict] = fetch_musicbrainz
    sparql: Callable[[str], dict] = post_sparql
    popularity: Callable[[Sequence[dict], Path], list[int]] = wikipedia_pops
    sleep: Callable[[float], None] = time.sleep
    log: Callable[[str], None] = print

    @classmethod
    def offline(cls, log: Callable[[str], None] = print) -> "Lookups":
        """Lookups that never touch the network: cached answers only, popularity zero."""
        return cls(
            musicbrainz=_offline_fetch,
            sparql=_offline_fetch,
            popularity=lambda entries, cache_dir: [0] * len(entries),
            sleep=lambda seconds: None,
            log=log,
        )


# --- The sidecar ---


@dataclass(frozen=True)
class CollectionSettings:
    """The settings of a whole collection, as `collection.toml` and the options give them.

    Attributes:
        id: the collection's id (a slug); also the catalog file's name and the songs' `source`.
        name: the playlist's name in the app.
        description: one line about the collection.
        order: place among the playlists (smaller first; the built-in ones use 10 to 50).
        default_sort: how the songs of the playlist are ordered: "order", "title" or "popularity".
        license: the license of every file that does not set its own.
        source: where the files come from or whom to credit (a link or a name).
    """

    id: str
    name: str
    description: str = ""
    order: float = LOCAL_ORDER
    default_sort: str = "popularity"
    license: str = ""
    source: str = ""


@dataclass(frozen=True)
class SongSettings:
    """What the sidecar says about one file; an empty or None field means "find it".

    Attributes:
        file: the path relative to the collection's folder, with forward slashes.
        title, composer, performer, album: as shown in the app.
        license, source: override the collection's.
        order: place in the playlist when it is sorted by "order".
        popularity: a number, higher is better known (Wikipedia page views per year).
        melody_track, bars: override the analysis (pretty_midi track index; bars [first, end)).
        public_domain: the student states that the composition is in the public domain.
        skip: leave the file out.
    """

    file: str
    title: str = ""
    composer: str = ""
    performer: str = ""
    license: str = ""
    source: str = ""
    album: str = ""
    order: float | None = None
    popularity: float | None = None
    melody_track: int | None = None
    bars: tuple[int, int] | None = None
    public_domain: bool = False
    skip: bool = False


def default_name(directory: Path) -> str:
    """Return a playlist name from a folder name: "old_masters" becomes "Old Masters"."""
    return re.sub(r"[-_]+", " ", directory.name).strip().title() or "Songs"


def find_midi_files(directory: Path) -> list[str]:
    """Return the MIDI files under a folder (any depth), relative and sorted, hidden ones out."""
    found = [
        path.relative_to(directory).as_posix()
        for path in directory.rglob("*")
        if path.is_file()
        and path.suffix.lower() in MIDI_SUFFIXES
        and not any(part.startswith(".") for part in path.relative_to(directory).parts)
    ]
    return sorted(found, key=lambda name: name.casefold())


def _typed(table: dict, key: str, kinds: tuple[type, ...], where: str):
    """Return table[key] after checking its type (a bool is not a number)."""
    value = table[key]
    if not isinstance(value, kinds) or (isinstance(value, bool) and bool not in kinds):
        raise ValueError(f"{where}: '{key}' must be a {' or '.join(k.__name__ for k in kinds)}")
    return value


def read_sidecar(directory: Path | str) -> tuple[CollectionSettings, list[SongSettings]]:
    """Read `collection.toml` of a folder.

    Raises:
        ValueError: with the field and file named, for a misspelled field, a wrong type, or a
            file that is not in the folder.
    """
    directory = Path(directory)
    path = directory / SIDECAR
    try:
        table = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as error:
        raise ValueError(f"{path} is not valid TOML: {error}") from error
    unknown = set(table) - COLLECTION_FIELDS - {"song"}
    if unknown:
        raise ValueError(
            f"{SIDECAR}: unknown field {sorted(unknown)[0]!r}; {_fields_hint(COLLECTION_FIELDS)}"
        )
    values = {
        key: _typed(table, key, (int, float) if key == "order" else (str,), SIDECAR)
        for key in COLLECTION_FIELDS & set(table)
    }
    if values.get("default_sort", "popularity") not in DEFAULT_SORTS:
        raise ValueError(f"{SIDECAR}: default_sort must be one of {', '.join(DEFAULT_SORTS)}")
    defaults = CollectionSettings(id=slugify(directory.name), name=default_name(directory))
    collection = CollectionSettings(**{**defaults.__dict__, **values})
    songs = []
    for block in table.get("song", []):
        label = f"{SIDECAR} [[song]] {block.get('file', '?')}"
        unknown = set(block) - SONG_FIELDS
        if unknown:
            raise ValueError(
                f"{label}: unknown field {sorted(unknown)[0]!r}; {_fields_hint(SONG_FIELDS)}"
            )
        if "file" not in block:
            raise ValueError(f"{label}: a [[song]] block needs a 'file'")
        fields = {
            key: _typed(block, key, SONG_FIELD_TYPES.get(key, (str,)), label)
            for key in SONG_FIELDS & set(block)
        }
        if "bars" in fields:
            bars = fields["bars"]
            if len(bars) != 2 or not all(isinstance(n, int) for n in bars) or bars[0] >= bars[1]:
                raise ValueError(f"{label}: bars must be [first, end] with first < end")
            fields["bars"] = (bars[0], bars[1])
        song = SongSettings(**fields)
        if not (directory / song.file).is_file():
            raise ValueError(f"{label}: the file is not in {directory.as_posix()}")
        songs.append(song)
    return collection, songs


def _fields_hint(allowed: set[str]) -> str:
    return "the fields are " + ", ".join(sorted(allowed))


@dataclass
class Settings:
    """The settings of a run: the collection's, and one entry per MIDI file in the folder."""

    collection: CollectionSettings
    songs: list[SongSettings]
    has_sidecar: bool


def load_settings(
    directory: Path,
    collection_id: str | None = None,
    name: str | None = None,
    license_text: str | None = None,
    source: str | None = None,
) -> Settings:
    """Combine the sidecar (when there is one), the files in the folder and the options.

    Options win over the sidecar, and the sidecar over the defaults. A file in the folder that
    the sidecar does not list gets the defaults, so adding a file needs no edit.

    Raises:
        ValueError: when the folder holds no MIDI file, or the sidecar is wrong.
    """
    files = find_midi_files(directory)
    if not files:
        raise ValueError(f"no .mid or .midi file in {directory.as_posix()}")
    has_sidecar = (directory / SIDECAR).exists()
    if has_sidecar:
        collection, listed = read_sidecar(directory)
    else:
        collection = CollectionSettings(id=slugify(directory.name), name=default_name(directory))
        listed = []
    changes = {
        key: value
        for key, value in (
            ("id", collection_id),
            ("name", name),
            ("license", license_text),
            ("source", source),
        )
        if value is not None
    }
    collection = CollectionSettings(**{**collection.__dict__, **changes})
    by_file = {song.file: song for song in listed}
    return Settings(collection, [by_file.get(f, SongSettings(f)) for f in files], has_sidecar)


def check_inside_repository(directory: Path | str, root: Path | str) -> Path:
    """Return the folder resolved, after checking that it lies inside the repository.

    GitHub Pages publishes the repository, and the app fetches the MIDI files from its own
    site, so a folder elsewhere would never be served.

    Raises:
        ValueError: "...inside the repository..." otherwise.
    """
    root = Path(root).resolve()
    if not (root / "arranger").is_dir():
        raise ValueError(f"{root} is not the repository (no arranger/ folder); use --root")
    directory = Path(directory).resolve()
    if not directory.is_dir():
        raise ValueError(f"{directory} is not a folder")
    try:
        directory.relative_to(root)
    except ValueError as error:
        raise ValueError(
            f"{directory} is not inside the repository {root}: the app serves files from the "
            "repository only, so put the folder inside it"
        ) from error
    if directory == root:
        raise ValueError("choose a folder inside the repository, not the repository itself")
    return directory


# --- Finding what each song is ---


@dataclass(frozen=True)
class CompositionStatus:
    """Whether a song's composition is in the public domain, from the composers' death years.

    Attributes:
        status: "yes" (every composer died in 1955 or earlier), "no" (one is alive or died later)
            or "unknown" (no composer, or Wikidata does not know one).
        detail: the evidence, for the preview.
    """

    status: str
    detail: str


def composition_status(composer: str, records: dict[str, AuthorRecord]) -> CompositionStatus:
    """Judge a composer string against the Wikidata records of its names.

    >>> bach = AuthorRecord("J. S. Bach", "Q1", 1750, "dead", "", "2026-10-20")
    >>> composition_status("J. S. Bach", {"J. S. Bach": bach})
    CompositionStatus(status='yes', detail='J. S. Bach, died 1750')
    >>> composition_status("Bach", {}).status  # a bare surname proves nothing
    'unknown'
    """
    names = split_composers(composer)
    if not names:
        return CompositionStatus("unknown", "no composer")
    surnames = [name for name in names if len(name.split()) < 2]
    if surnames:
        # Wikidata matches a name by its label, and "Bach" is the label of some other Bach too.
        return CompositionStatus(
            "unknown",
            f"{surnames[0]} is only a surname: use the full name, or set public_domain = true",
        )
    found = [records[name] for name in names if name in records]
    if len(found) < len(names):
        return CompositionStatus("unknown", "Wikidata could not be asked")

    def evidence(record: AuthorRecord) -> str:
        if record.status == "dead" and record.qid is None:
            return (
                f"{record.name}: several people share the name, and all died by {record.death_year}"
            )
        if record.status == "dead":
            return f"{record.name}, died {record.death_year}"
        if record.status == "alive":
            return f"{record.name} is alive"
        return f"{record.name} is not on Wikidata"

    detail = "; ".join(evidence(record) for record in found)
    if is_public_domain(found):
        return CompositionStatus("yes", detail)
    protected = any(
        r.status == "alive" or not is_public_domain([r]) for r in found if r.status != "unknown"
    )
    return CompositionStatus("no" if protected else "unknown", detail)


@dataclass
class SongReport:
    """Everything known about one file: found, set by the student, and measured."""

    settings: SongSettings
    song_id: str
    identity: Identity
    status: CompositionStatus
    popularity: int
    popularity_from: str
    album: str
    tracks: str
    facts: dict
    license: str = ""  # as the student wrote it: the song's own, else the collection's

    @property
    def file(self) -> str:
        return self.settings.file


def _song_ids(files: Sequence[str]) -> dict[str, str]:
    """Give each file a unique id: the slug of its path, with -2, -3... for repeats."""
    ids: dict[str, str] = {}
    taken: set[str] = set()
    for file in files:
        base = slugify(Path(file).with_suffix("").as_posix())
        song_id, number = base, 2
        while song_id in taken:
            song_id = f"{base}-{number}"
            number += 1
        taken.add(song_id)
        ids[file] = song_id
    return ids


def _identity_of(path: Path, song: SongSettings, root: Path, lookups: Lookups) -> Identity:
    """The identity of a file: the sidecar's title and composer when both are set, else a lookup."""
    if song.title and song.composer:
        return Identity(
            song.title, song.composer, "collection.toml", "collection.toml", "high", "",
            "set in collection.toml",
        )  # fmt: skip
    found = identify_song(path, root / MUSICBRAINZ_CACHE, lookups.musicbrainz, lookups.sleep)
    if not (song.title or song.composer):
        return found
    return Identity(
        song.title or found.title,
        song.composer or found.composer,
        "collection.toml" if song.title else found.title_from,
        "collection.toml" if song.composer else found.composer_from,
        found.confidence,
        found.musicbrainz,
        found.note,
    )


def _tracks_text(path: Path, melody_track: int | None) -> str:
    """List a file's tracks for the sidecar: `0 "bass"; 1 "voz" (melody); 2 "drums" (drums)`."""
    try:
        tracks = describe_tracks(pretty_midi.PrettyMIDI(str(path)))
    except Exception:  # an unreadable file is reported by the analysis
        return ""
    return "; ".join(
        f'{t.index} "{t.name}"'
        + (" (drums)" if t.is_drum else "")
        + (" (melody)" if t.index == melody_track else "")
        for t in tracks
    )


def analyze_collection(
    directory: Path, root: Path, settings: Settings, lookups: Lookups
) -> list[SongReport]:
    """Find and measure every file that is not skipped (see the module docstring)."""
    songs = [song for song in settings.songs if not song.skip]
    ids = _song_ids([song.file for song in settings.songs])
    identities = []
    for number, song in enumerate(songs, start=1):
        identities.append(_identity_of(directory / song.file, song, root, lookups))
        lookups.log(f"{number}/{len(songs)} files identified: {song.file}")

    names = list(dict.fromkeys(n for i in identities for n in split_composers(i.composer)))
    try:
        resolved = resolve_names(
            names, root / WIKIDATA_CACHE, lookups.sparql, lookups.sleep, log=lambda line: None
        )
        records = {record.name: _with_namesakes(record, root) for record in resolved}
    except (OSError, ValueError):
        records = {}  # Wikidata could not be asked: every composition stays "unknown"

    asked = iter(
        _popularity_of(
            [
                {"t": identity.title, "c": identity.composer, "p": song.performer}
                for song, identity in zip(songs, identities, strict=True)
                if song.popularity is None
            ],
            root,
            lookups,
        )
    )
    reports = []
    for song, identity in zip(songs, identities, strict=True):
        path = directory / song.file
        facts = analyze_and_reduce(path, None, song.melody_track, song.bars)[0]
        facts["midi"] = _app_path(path, root)
        if song.popularity is not None:
            popularity, origin = int(song.popularity), "collection.toml"
        else:
            popularity = next(asked)
            origin = "Wikipedia page views" if popularity else "none found"
        folder = Path(song.file).parent.as_posix()
        status = (
            CompositionStatus("yes", "stated in collection.toml")
            if song.public_domain
            else composition_status(identity.composer, records)
        )
        reports.append(
            SongReport(
                settings=song,
                song_id=ids[song.file],
                identity=identity,
                status=status,
                popularity=popularity,
                popularity_from=origin,
                album=song.album or ("" if folder == "." else folder) or identity.composer,
                tracks=_tracks_text(path, facts.get("melody_track")),
                facts=facts,
                license=song.license or settings.collection.license,
            )
        )
    return reports


def _with_namesakes(record: AuthorRecord, root: Path) -> AuthorRecord:
    """Settle a name that several people share when every one of them died long ago.

    `resolve_names` leaves such a name "unknown" (it cannot tell which person is meant), but a
    composition is free whichever one wrote it when all of them died by 1955. The record then
    has no Wikidata item (`qid` None) and the latest death year among them.
    """
    if record.status != "unknown" or record.qid is not None:
        return record
    year = namesakes_death_year(record.name, root / WIKIDATA_CACHE)
    if year is None:
        return record
    return replace(record, death_year=year, status="dead")


def _popularity_of(entries: list[dict], root: Path, lookups: Lookups) -> list[int]:
    if not entries:
        return []
    try:
        return lookups.popularity(entries, root / POPULARITY_CACHE)
    except (OSError, ValueError):
        return [0] * len(entries)  # Wikipedia could not be asked: no popularity, not an error


def _app_path(path: Path, root: Path) -> str:
    """Return a file's path as the app reaches it: relative to `arranger/`, so `../songs/x.mid`."""
    return "../" + path.resolve().relative_to(root.resolve()).as_posix()


# --- The license rules ---


@dataclass(frozen=True)
class Excluded:
    """A song `build` leaves out, and why."""

    file: str
    reason: str


def license_problems(settings: Settings, reports: Sequence[SongReport]) -> list[str]:
    """List why the licenses cannot be accepted; empty when `build` may go on.

    A song needs a license of its own or the collection's; the license must allow
    redistribution; and one that asks for credit needs a source (the song's or the collection's).
    """
    problems = []
    for report in reports:
        song = report.settings
        if not report.license.strip():
            problems.append(f"{song.file}: no license")
            continue
        canonical = canonical_license(report.license)
        if canonical is None:
            problems.append(
                f"{song.file}: license {report.license!r} does not allow redistribution"
            )
        elif canonical not in NO_CREDIT_NEEDED and not (song.source or settings.collection.source):
            problems.append(
                f"{song.file}: license {canonical} asks for credit, so a source is needed "
                "(--source <link or name>)"
            )
    return problems


def refusal_message(problems: Sequence[str]) -> str:
    """Return the message that refuses a build: what is wrong, and which licenses are accepted."""
    lines = ["the collection cannot be built:", *[f"  {problem}" for problem in problems]]
    if any(problem.endswith("no license") for problem in problems):
        lines.append(
            "  set one license for the folder: --license CC0-1.0 (or write it in collection.toml)"
        )
    lines.append(f"accepted licenses: {ALLOWED_LICENSE_HELP}")
    return "\n".join(lines)


def exclusion_reason(report: SongReport, include_unconfirmed: bool) -> str:
    """Return why `build` leaves a song out ("" if it stays).

    Only the `public-domain` license is checked against the composer: it claims the composition
    is free, so Wikidata must confirm that every composer died in 1955 or earlier.
    """
    if include_unconfirmed or canonical_license(report.license) != "public-domain":
        return ""
    if report.status.status == "yes":
        return ""
    return (
        "the license is public-domain, but the composer is not confirmed as such "
        f"({report.status.detail}); pass --include-unconfirmed, or set public_domain = true "
        "for this file in collection.toml"
    )


# --- init ---


def _toml(value: object) -> str:
    """Write a value as TOML (a JSON string, number or list is valid TOML)."""
    return json.dumps(value, ensure_ascii=False)


def found_line(report: SongReport) -> str:
    """Say in one line where a song's title and composer came from (sidecar and preview)."""
    identity = report.identity
    label = "low confidence" if identity.confidence == "low" else identity.confidence
    composer = (
        f"composer from {identity.composer_from} ({label})"
        if identity.composer
        else f"no composer found ({label})"
    )
    return f"title from {identity.title_from}; {composer}"


def _song_block(report: SongReport, rank: int) -> str:
    song, facts = report.settings, report.facts
    lines = [
        "[[song]]",
        f"file = {_toml(song.file)}",
        f"title = {_toml(report.identity.title)}",
        f"composer = {_toml(report.identity.composer)}",
        f"# found: {found_line(report)}",
        f"# composition public domain: {report.status.status} ({report.status.detail})",
    ]
    if report.identity.confidence == "low":
        lines.append(f"# {report.identity.note}")
    if report.tracks:
        lines.append(f"# tracks: {report.tracks}")
    if "error" in facts:
        lines.append(f"# cannot be arranged: {facts['error']}")
    lines += [
        "# Optional: uncomment a line to override what was found.",
        '# performer = ""',
        '# license = ""',
        '# source = ""',
        f"# album = {_toml(report.album)}",
        f"# popularity = {report.popularity}",
        f"# order = {rank}",
    ]
    if "error" not in facts:
        lines += [f"# melody_track = {facts['melody_track']}", f"# bars = {_toml(facts['bars'])}"]
    lines += ["# public_domain = true", "# skip = false"]
    return "\n".join(lines) + "\n"


def _sidecar_header(settings: CollectionSettings) -> str:
    return (
        "# Settings of this collection. Nothing here has to be edited: `collection build` finds\n"
        '# the rest by itself. See the README, "Your own MIDI collections".\n'
        f"id = {_toml(settings.id)}\n"
        f"name = {_toml(settings.name)}  # the playlist's name in the app\n"
        f"description = {_toml(settings.description)}\n"
        f"order = {settings.order:g}  # place among the playlists: the built-in ones are 10 to 50\n"
        '# How the songs are sorted: "order" (the order numbers below), "title" or "popularity".\n'
        f"default_sort = {_toml(settings.default_sort)}\n"
        "# One license for every file (a file can override it below).\n"
        f"# Accepted: {ALLOWED_LICENSE_HELP}\n"
        f"license = {_toml(settings.license)}\n"
        "# Where the files come from, or whom to credit: required by CC-BY style licenses.\n"
        f"source = {_toml(settings.source)}\n"
    )


def init_collection(
    directory: Path | str,
    root: Path | str = ".",
    lookups: Lookups | None = None,
    collection_id: str | None = None,
    name: str | None = None,
    license_text: str | None = None,
    source: str | None = None,
) -> tuple[Path, list[str]]:
    """Write `collection.toml` for a folder, with everything found; return it and the new files.

    An existing sidecar is never rewritten: files it does not list yet are appended at the end,
    so the student's edits stay. The sidecar is only an override file: `build` needs none.

    Args:
        directory: a folder inside the repository with MIDI files.
        root: the repository folder.
        lookups: the online lookups (default: the real ones).
        collection_id, name, license_text, source: the collection's settings (see
            `CollectionSettings`); they are written into a new sidecar only.

    Returns:
        The sidecar's path, and the files added to it.

    Raises:
        ValueError: when the folder is outside the repository or holds no MIDI file, or the id
            is refused.
    """
    root = Path(root).resolve()
    lookups = lookups or Lookups()
    directory = check_inside_repository(directory, root)
    settings = load_settings(directory, collection_id, name, license_text, source)
    check_new_id(root, settings.collection.id, "local-midi")
    sidecar = directory / SIDECAR
    listed = {song.file for song in read_sidecar(directory)[1]} if settings.has_sidecar else set()
    fresh = Settings(
        settings.collection,
        [song for song in settings.songs if song.file not in listed],
        settings.has_sidecar,
    )
    if not fresh.songs:
        return sidecar, []
    reports = analyze_collection(directory, root, fresh, lookups)
    ranked = sorted(reports, key=lambda report: -report.popularity)
    blocks = "\n".join(_song_block(r, ranked.index(r) + 1) for r in reports)
    if settings.has_sidecar:
        text = sidecar.read_text(encoding="utf-8").rstrip("\n") + "\n\n" + blocks
    else:
        text = _sidecar_header(settings.collection) + "\n" + blocks
    sidecar.write_text(text, encoding="utf-8")
    return sidecar, [report.file for report in reports]


# --- preview ---


def sorted_for_app(reports: Sequence[SongReport], default_sort: str) -> list[SongReport]:
    """Order songs as the app's playlist does (`sortCollection` in `core/playlists.js`).

    "popularity": best known first, then the `order` numbers, then the title. "order": the
    `order` numbers, then the title. "title": the title without accents or letter case.
    """

    def title(report: SongReport) -> str:
        return normalized_title(report.identity.title)

    def order(report: SongReport) -> float:
        return float("inf") if report.settings.order is None else report.settings.order

    if default_sort == "title":
        return sorted(reports, key=lambda r: (title(r), r.song_id))
    if default_sort == "order":
        return sorted(reports, key=lambda r: (order(r), title(r), r.song_id))
    return sorted(reports, key=lambda r: (-r.popularity, order(r), title(r), r.song_id))


def album_groups(reports: Sequence[SongReport]) -> list[tuple[str, list[SongReport]]]:
    """Group sorted songs into albums by first appearance; songs with no album come last."""
    groups: dict[str, list[SongReport]] = {}
    for report in reports:
        groups.setdefault(report.album, []).append(report)
    named = [(name, songs) for name, songs in groups.items() if name]
    if not named:
        return [("", list(reports))]
    return [*named, *([("", groups[""])] if "" in groups else [])]


def _track_name(report: SongReport, index: int) -> str:
    found = re.search(rf'(?:^|; ){index} "([^"]*)"', report.tracks)
    return found.group(1) if found else ""


def preview_text(
    settings: Settings, reports: Sequence[SongReport], include_unconfirmed: bool = False
) -> str:
    """Return how the playlist will look in the app, with where each fact was found."""
    collection = settings.collection
    if collection.license:
        shown = canonical_license(collection.license) or f"{collection.license!r} (not accepted)"
        license_line = f"license {shown}" + (
            f", source {collection.source}" if collection.source else ""
        )
    else:
        license_line = "no license set (pass --license or write it in collection.toml)"
    lines = [
        f'Playlist "{collection.name}" (id {collection.id}, order {collection.order:g}), '
        f"{len(reports)} songs, sorted by {collection.default_sort}",
        license_line,
        "",
    ]
    ordered = sorted_for_app(reports, collection.default_sort)
    has_albums = any(report.album for report in ordered)
    number = 0
    for album, songs in album_groups(ordered):
        lines.append(f"Album: {album or 'Other songs'}" if has_albums else "Songs")
        for report in songs:
            number += 1
            facts = report.facts
            by = f" - {report.identity.composer}" if report.identity.composer else ""
            lines.append(f"  {number}. {report.identity.title}{by}  [{report.file}]")
            license_shown = canonical_license(report.license) or report.license or "no license"
            if "error" in facts:
                lines.append(f"     {license_shown} | cannot be arranged: {facts['error']}")
            else:
                first, end = facts["bars"]
                lines.append(
                    f"     {license_shown} | track {facts['melody_track']} "
                    f'"{_track_name(report, facts["melody_track"])}", bars {first}-{end} | '
                    f"{facts['key']}, {facts['tempo_bpm']:g} BPM, {facts['meter']}"
                )
            lines.append(f"     found: {found_line(report)}")
            lines.append(
                f"     composition public domain: {report.status.status} ({report.status.detail})"
                f" | popularity {report.popularity} ({report.popularity_from})"
            )
            reason = exclusion_reason(report, include_unconfirmed)
            if reason:
                lines.append(f"     NOT INCLUDED: {reason}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def preview_collection(
    directory: Path | str,
    root: Path | str = ".",
    lookups: Lookups | None = None,
    collection_id: str | None = None,
    name: str | None = None,
    license_text: str | None = None,
    source: str | None = None,
    include_unconfirmed: bool = False,
) -> str:
    """Return how the collection will look in the app; nothing is written, as in `build`."""
    root = Path(root).resolve()
    directory = check_inside_repository(directory, root)
    settings = load_settings(directory, collection_id, name, license_text, source)
    reports = analyze_collection(directory, root, settings, lookups or Lookups())
    return preview_text(settings, reports, include_unconfirmed)


# --- build ---


@dataclass
class BuildResult:
    """What `build` did.

    Attributes:
        catalog_path: the catalog file written.
        entries: the catalog entries, in file order.
        problems: files kept in the catalog although they cannot be arranged, "file: reason".
        unconfirmed: songs left out because the public-domain license was not confirmed.
    """

    catalog_path: Path
    entries: list[dict]
    problems: list[str] = field(default_factory=list)
    unconfirmed: list[Excluded] = field(default_factory=list)


def _entry(report: SongReport, settings: Settings) -> dict:
    """Return the catalog entry of one song (the shared schema, `contracts/catalog-files.md`)."""
    song, collection, identity = report.settings, settings.collection, report.identity
    entry: dict = {
        "id": report.song_id,
        "source": collection.id,
        "t": identity.title,
        "c": identity.composer,
        "p": song.performer,
        "license": canonical_license(report.license) or report.license,
        "seed": sprite_seed(collection.id, report.song_id),
    }
    credit = song.source or collection.source
    if credit:
        entry["credit"] = credit
    if report.album:
        entry["album"] = report.album
    if song.order is not None:
        entry["order"] = song.order
    if report.popularity:
        entry["pop"] = report.popularity
    facts = dict(report.facts)
    error = facts.pop("error", None)
    if error is None:
        entry["route"] = {"midi": facts["midi"]}
    entry["facts"] = facts
    if error is not None:
        entry["error"] = error
    return entry


def build_collection(
    directory: Path | str,
    root: Path | str = ".",
    lookups: Lookups | None = None,
    collection_id: str | None = None,
    name: str | None = None,
    license_text: str | None = None,
    source: str | None = None,
    include_unconfirmed: bool = False,
) -> BuildResult:
    """Write the collection's catalog file and register it for the app.

    Args:
        directory: a folder inside the repository with MIDI files (and maybe `collection.toml`).
        root: the repository folder.
        lookups: the online lookups (default: the real ones).
        collection_id, name, license_text, source: override the sidecar's collection settings.
        include_unconfirmed: keep songs of a `public-domain` collection whose composer Wikidata
            does not confirm as dead before 1956.

    Returns:
        The catalog written and what was left out or could not be arranged.

    Raises:
        ValueError: when a song has no accepted license (the message lists them), the folder is
            outside the repository, or the id is refused. Nothing is written then.
    """
    root = Path(root).resolve()
    directory = check_inside_repository(directory, root)
    settings = load_settings(directory, collection_id, name, license_text, source)
    collection = settings.collection
    check_new_id(root, collection.id, "local-midi")
    reports = analyze_collection(directory, root, settings, lookups or Lookups())
    problems = license_problems(settings, reports)
    if problems:
        raise ValueError(refusal_message(problems))

    kept, unconfirmed = [], []
    for report in reports:
        reason = exclusion_reason(report, include_unconfirmed)
        if reason:
            unconfirmed.append(Excluded(report.file, reason))
        else:
            kept.append(report)
    entries = [_entry(report, settings) for report in kept]
    credits = sorted({entry["credit"] for entry in entries if "credit" in entry})
    relative_dir = directory.relative_to(root).as_posix()
    envelope = {
        "source": collection.id,
        "name": collection.name,
        "home": REPO_HOME,
        "license": ", ".join(sorted({entry["license"] for entry in entries}))
        + " (each song carries its own license field)",
        "credit": "; ".join(credits) or "The collection's owner",
        "note": f"MIDI files committed to {relative_dir}/ and served from this site. Titles and "
        "composers found from the file names and MusicBrainz, composers' death years from "
        "Wikidata, popularity from Wikipedia page views; facts measured on each MIDI file.",
        "generated": f"uv run src/main.py collection build {relative_dir}",
    }
    catalog_path = write_catalog_file(
        root / CATALOG_DIR / f"{collection.id}.json", envelope, entries
    )
    previous = next((r for r in read_registry(root) if r["id"] == collection.id), None)
    register(
        root,
        {
            "id": collection.id,
            "path": f"data/catalog/{collection.id}.json",
            "name": collection.name,
            "kind": "local-midi",
            "lazy": previous["lazy"] if previous else False,
            "order": collection.order,
            "enabled": previous["enabled"] if previous else True,
            "generated": envelope["generated"],
            "description": collection.description,
            "default_sort": collection.default_sort,
            "dir": relative_dir,
        },
    )
    unarrangeable = [f"{r.file}: {r.facts['error']}" for r in kept if "error" in r.facts]
    return BuildResult(catalog_path, entries, unarrangeable, unconfirmed)


# --- Command line ---


def add_own_collection_commands(command: Callable[..., argparse.ArgumentParser]) -> None:
    """Add `collection init`, `preview` and `build` (called by `catalog.collection_cli`)."""
    for name, help_text, handler in (
        (
            "init",
            "write collection.toml for a folder of MIDI files, with everything found",
            run_init,
        ),
        ("preview", "print how a folder will look in the app; writes nothing", run_preview),
        ("build", "write the folder's catalog file and register it for the app", run_build),
    ):
        parser = command(name, help_text, handler)
        parser.add_argument("directory", type=Path, help="a folder inside the repository")
        parser.add_argument(
            "--license",
            dest="license_text",
            help="one license for the whole folder (see the README)",
        )
        parser.add_argument("--source", help="where the files come from, or whom to credit")
        parser.add_argument(
            "--id", dest="collection_id", help="collection id (default: folder name)"
        )
        parser.add_argument("--name", help="playlist name (default: the folder's name)")
        parser.add_argument(
            "--offline", action="store_true", help="use cached answers only; no network"
        )
        if name != "init":
            parser.add_argument(
                "--include-unconfirmed",
                action="store_true",
                help="keep songs whose composer is not confirmed public domain "
                "(public-domain license only)",
            )


def _options(args: argparse.Namespace) -> dict:
    return {
        "lookups": Lookups.offline() if args.offline else Lookups(),
        "collection_id": args.collection_id,
        "name": args.name,
        "license_text": args.license_text,
        "source": args.source,
    }


def run_init(args: argparse.Namespace) -> None:
    """Write the sidecar and say what to do next."""
    sidecar, added = init_collection(args.directory, args.root, **_options(args))
    if added:
        print(f"{sidecar}: {len(added)} files added. Check the titles and composers, then:")
        print(f"  uv run src/main.py collection preview {args.directory}")
    else:
        print(f"{sidecar}: no new files")


def run_preview(args: argparse.Namespace) -> None:
    """Print the preview."""
    text = preview_collection(
        args.directory, args.root, include_unconfirmed=args.include_unconfirmed, **_options(args)
    )
    print(text, end="")


def run_build(args: argparse.Namespace) -> None:
    """Build, then say what was written, what was left out and what to commit."""
    result = build_collection(
        args.directory, args.root, include_unconfirmed=args.include_unconfirmed, **_options(args)
    )
    print(f"{len(result.entries)} songs: {result.catalog_path}")
    for excluded in result.unconfirmed:
        print(f"  left out {excluded.file}: {excluded.reason}")
    for problem in result.problems:
        print(f"  cannot be arranged {problem}")
    print("Commit and push the MIDI files, collection.toml and arranger/data/catalog/ to publish.")
