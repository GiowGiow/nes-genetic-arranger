"""The registry of collections: which song lists the app offers, and how to manage them.

The song browser shows one playlist per *collection*: the eight examples, the MPB songs, the
public-domain lead sheets, folk tunes, a classical subset, and any folder of MIDI files the
student adds. One small file lists them all, `arranger/data/catalog/collections.json`, and the
app reads it before anything else, so adding, hiding, renaming or reordering a collection needs
no code change. Each record says:

- `id` and `path`: the collection's catalog file (`data/catalog/<id>.json`, relative to the app
  folder `arranger/`);
- `name`: the title of its playlist tile;
- `kind`: how its songs load. `abc` songs are lead sheets committed to the repository;
  `local-midi` songs are MIDI files committed to a folder of the repository (the app fetches
  them from its own site); `remote` songs live on another site and open by download, so the
  repository holds only their titles and links;
- `lazy`: read the file only when the visitor needs it (a big file, such as MPB's 2 MB);
- `order`: the place of its tile among the playlists (smaller comes first);
- `enabled`: a disabled collection is not loaded and has no tile, but stays on disk;
- `generated`: the command that rebuilds the file.

Local MIDI records also carry `dir` (the folder), `description` and `default_sort`; remote ones
made by `add-remote` carry `from` (the list of links they were made from).

The `collection` command (`uv run src/main.py collection ...`) manages the registry:

    collection list | show <id>
    collection enable <id> | disable <id> | rename <id> "<name>"
    collection order <id> <n> | move <id> --before <other> | lazy <id> on|off
    collection rebuild <id> | add-remote <id> ... | remove <id>

and `collection init|preview|build` make a collection from a folder of MIDI files
(`catalog.own_collection`). Without a registry file, the built-in collections apply, so a fresh
clone behaves as the app always did; the first change writes the file.
"""

import csv
import json
import re
import shutil
from collections import Counter
from collections.abc import Callable, Sequence
from pathlib import Path
from urllib.parse import urlparse

from catalog.cards import ENVELOPE_FIELDS, sprite_seed, write_catalog_file

REGISTRY_PATH = Path("arranger/data/catalog/collections.json")
CATALOG_DIR = Path("arranger/data/catalog")
ABC_DIR = Path("data/catalog/abc")  # committed lead sheets, per collection
KINDS = ("local-midi", "abc", "remote")
RECORD_FIELDS = ("id", "path", "name", "kind", "lazy", "order", "enabled", "generated")
EXTRA_FIELDS = ("description", "default_sort", "dir", "from")
ORDER_STEP = 10
LOCAL_ORDER = 100  # a new collection comes after the built-in ones
# Ids the app uses for something else: its playlists and the kinds of songs it adds itself.
RESERVED_IDS = frozenset(
    {"popular", "yours", "local", "thesession", "choro", "folk", "classical", "all"}
)
ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")
MAX_ID_LENGTH = 40
POPULARITY_STEP = ["catalog", "popularity"]


def _builtin(id_: str, name: str, kind: str, lazy: bool, order: int, generated: str) -> dict:
    return {
        "id": id_,
        "path": f"data/catalog/{id_}.json",
        "name": name,
        "kind": kind,
        "lazy": lazy,
        "order": order,
        "enabled": True,
        "generated": generated,
    }


# The same list sits in `arranger/src/core/sources.js` as the fallback for a missing registry;
# a test on each side compares it with the committed file.
BUILTIN_COLLECTIONS: tuple[dict, ...] = (
    _builtin(
        "examples",
        "Examples",
        "abc",
        False,
        10,
        "uv run src/main.py catalog examples; then uv run src/main.py catalog popularity",
    ),
    _builtin(
        "mpb",
        "MPB",
        "remote",
        True,
        20,
        "uv run src/main.py catalog analyze --dataset <local MPB study copy>; "
        "then uv run src/main.py catalog popularity",
    ),
    _builtin(
        "public-domain",
        "Choro & public domain",
        "abc",
        False,
        30,
        "uv run src/main.py catalog public-domain --dataset <local MPB study copy>; "
        "then uv run src/main.py catalog popularity",
    ),
    _builtin(
        "nottingham",
        "Folk tunes",
        "abc",
        False,
        40,
        "uv run src/main.py catalog nottingham; then uv run src/main.py catalog popularity",
    ),
    _builtin(
        "pdmx",
        "Classical & standards",
        "abc",
        False,
        50,
        "uv run src/main.py catalog pdmx --limit 300; then uv run src/main.py catalog popularity",
    ),
)
BUILTIN_IDS = frozenset(record["id"] for record in BUILTIN_COLLECTIONS)

# What a built-in rebuild runs, and what it needs on disk first: (steps, needs).
# A step is a `main.py` argument list; `{dataset}` is the MPB study copy.
BUILTIN_REBUILDS: dict[str, tuple[list[list[str]], list[str]]] = {
    "examples": ([["catalog", "examples"], POPULARITY_STEP], []),
    "mpb": ([["catalog", "analyze", "--dataset", "{dataset}"], POPULARITY_STEP], ["dataset"]),
    "public-domain": (
        [["catalog", "public-domain", "--dataset", "{dataset}"], POPULARITY_STEP],
        ["dataset", "data/catalog/authors.json"],
    ),
    "nottingham": ([["catalog", "nottingham"], POPULARITY_STEP], ["data/raw/nottingham"]),
    "pdmx": (
        [["catalog", "pdmx"], POPULARITY_STEP],
        ["data/raw/pdmx", "data/catalog/authors.json"],
    ),
}
NEEDS_HELP = {
    "data/raw/nottingham": "download the Nottingham ABC files first (see the README)",
    "data/raw/pdmx": "download the PDMX dataset first (see the README)",
    "data/catalog/authors.json": "run `uv run src/main.py catalog authors` first",
}

Runner = Callable[[list[str]], int]


# --- The registry file ---


def registry_path(root: Path | str = ".") -> Path:
    """Return the registry file of the repository at `root`."""
    return Path(root) / REGISTRY_PATH


def _ordered(record: dict) -> dict:
    """Return the record with its keys in the file's order (fields first, then the extras)."""
    known = [*RECORD_FIELDS, *EXTRA_FIELDS]
    return {key: record[key] for key in known if key in record} | {
        key: value for key, value in record.items() if key not in known
    }


def _checked(record: dict) -> dict:
    """Validate one record and return it with the optional fields defaulted.

    >>> _checked({"id": "x", "path": "data/catalog/x.json", "name": "X", "kind": "abc"})["enabled"]
    True
    """
    label = repr(record.get("id", "?"))
    for field in ("id", "path", "name", "kind"):
        if not isinstance(record.get(field), str) or not record[field]:
            raise ValueError(f"registry record {label} has no {field}")
    if record["kind"] not in KINDS:
        raise ValueError(f"registry record {label}: kind must be one of {', '.join(KINDS)}")
    for field in ("lazy", "enabled"):
        if not isinstance(record.get(field, field == "enabled"), bool):
            raise ValueError(f"registry record {label}: {field} must be true or false")
    if not isinstance(record.get("order", 0), int | float):
        raise ValueError(f"registry record {label}: order must be a number")
    return _ordered(
        {"lazy": False, "enabled": True, "order": LOCAL_ORDER, "generated": ""} | dict(record)
    )


def read_registry(root: Path | str = ".") -> list[dict]:
    """Return the records of the registry, in the order the app shows them.

    A repository without the file has the built-in collections. A record that cannot be read
    stops the command with the reason, rather than being dropped silently.

    Raises:
        ValueError: when the file is not a registry, or a record lacks a field.
    """
    path = registry_path(root)
    if not path.exists():
        return [dict(record) for record in BUILTIN_COLLECTIONS]
    try:
        stored = json.loads(path.read_text(encoding="utf-8"))["collections"]
    except (ValueError, KeyError, TypeError) as error:
        raise ValueError(f"{path} is not a collection registry ({error})") from error
    return sorted(
        (_checked(record) for record in stored), key=lambda r: (r["order"], r["name"].casefold())
    )


def write_registry(root: Path | str, records: Sequence[dict]) -> Path:
    """Write the registry, records sorted by order then name, one record per line."""
    ordered = sorted(
        (_checked(record) for record in records), key=lambda r: (r["order"], r["name"].casefold())
    )
    lines = ",\n".join(
        "    " + json.dumps(record, ensure_ascii=False, separators=(",", ":")) for record in ordered
    )
    path = registry_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{\n  "collections": [\n' + lines + "\n  ]\n}\n", encoding="utf-8")
    return path


def find_record(records: Sequence[dict], collection_id: str) -> dict:
    """Return the record with this id.

    Raises:
        ValueError: "no collection 'x'; the collections are: ..." when there is none.
    """
    for record in records:
        if record["id"] == collection_id:
            return record
    known = ", ".join(record["id"] for record in records)
    raise ValueError(f"no collection '{collection_id}'; the collections are: {known}")


def register(root: Path | str, record: dict) -> None:
    """Add a record to the registry, or replace the one with the same id, and write the file."""
    records = [r for r in read_registry(root) if r["id"] != record["id"]]
    write_registry(root, [*records, record])


def check_new_id(root: Path | str, collection_id: str, kind: str) -> None:
    """Refuse an id the app cannot use for a collection of this kind.

    An id is a lowercase slug (letters, digits, dashes). It must not be an id the app uses for
    something else, a built-in collection, or a collection of another kind.

    Raises:
        ValueError: with the reason.
    """
    if not ID_PATTERN.match(collection_id) or len(collection_id) > MAX_ID_LENGTH:
        raise ValueError(
            f"collection id '{collection_id}' must be lowercase letters, digits and dashes "
            f"(at most {MAX_ID_LENGTH}), starting with a letter or digit"
        )
    if collection_id in RESERVED_IDS:
        raise ValueError(f"collection id '{collection_id}' is reserved by the app")
    if collection_id in BUILTIN_IDS:
        raise ValueError(f"collection id '{collection_id}' is a built-in collection")
    existing = next((r for r in read_registry(root) if r["id"] == collection_id), None)
    if existing and existing["kind"] != kind:
        raise ValueError(
            f"collection id '{collection_id}' is already a {existing['kind']} collection"
        )


def is_builtin(collection_id: str) -> bool:
    """Say whether an id is one of the built-in collections."""
    return collection_id in BUILTIN_IDS


def _update(root: Path | str, collection_id: str, **changes: object) -> dict:
    records = read_registry(root)
    record = find_record(records, collection_id)
    record.update(changes)
    write_registry(root, records)
    return record


# --- list and show ---


def _catalog_file(root: Path | str, record: dict) -> Path:
    return Path(root) / "arranger" / record["path"]


def _read_catalog(root: Path | str, record: dict) -> dict | None:
    try:
        return json.loads(_catalog_file(root, record).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _size_text(size: int) -> str:
    return f"{size / 1024 / 1024:.1f} MB" if size >= 1024 * 1024 else f"{size / 1024:.0f} KB"


def list_collections(root: Path | str = ".") -> str:
    """Return the table of collections: id, name, kind, songs, enabled, order, size and lazy."""
    rows = [["id", "name", "kind", "songs", "enabled", "order", "size", "lazy"]]
    for record in read_registry(root):
        catalog = _read_catalog(root, record)
        file = _catalog_file(root, record)
        rows.append(
            [
                record["id"],
                record["name"],
                record["kind"],
                str(len(catalog["entries"])) if catalog else "missing",
                "yes" if record["enabled"] else "no",
                f"{record['order']:g}",
                _size_text(file.stat().st_size) if file.exists() else "missing",
                "yes" if record["lazy"] else "no",
            ]
        )
    widths = [max(len(row[column]) for row in rows) for column in range(len(rows[0]))]
    return "\n".join(
        "  ".join(cell.ljust(width) for cell, width in zip(row, widths, strict=True)).rstrip()
        for row in rows
    )


def show_collection(root: Path | str, collection_id: str, first: int = 5) -> str:
    """Return a collection's record, its catalog envelope, its first songs and its counts."""
    record = find_record(read_registry(root), collection_id)
    lines = [f"{key}: {value}" for key, value in record.items()]
    catalog = _read_catalog(root, record)
    if catalog is None:
        return "\n".join([*lines, f"catalog file {record['path']} is missing"])
    lines += [f"{field}: {catalog[field]}" for field in ENVELOPE_FIELDS[2:]]
    entries = catalog["entries"]
    lines.append(f"songs: {len(entries)}")
    lines.append(f"first {min(first, len(entries))}:")
    lines += [
        f"  {entry['t']} ({entry.get('c', '') or entry.get('p', '') or 'no composer'})"
        for entry in entries[:first]
    ]
    licenses = Counter(entry.get("license", "none") for entry in entries)
    routes = Counter(
        next(iter(entry.get("route", {"none": 0})), "none") if "error" not in entry else "error"
        for entry in entries
    )
    lines.append("by license: " + ", ".join(f"{k}: {n}" for k, n in sorted(licenses.items())))
    lines.append("by route: " + ", ".join(f"{k}: {n}" for k, n in sorted(routes.items())))
    return "\n".join(lines)


# --- Small changes ---


def set_enabled(root: Path | str, collection_id: str, enabled: bool) -> dict:
    """Turn a collection on or off; a disabled one is not loaded, but its file stays."""
    return _update(root, collection_id, enabled=enabled)


def rename_collection(root: Path | str, collection_id: str, name: str) -> dict:
    """Change the name of a collection's playlist; a local MIDI collection's sidecar follows."""
    if not name.strip():
        raise ValueError("the name is empty")
    record = _update(root, collection_id, name=name.strip())
    _mirror_in_sidecar(root, record, "name", record["name"])
    return record


def set_order(root: Path | str, collection_id: str, order: float) -> dict:
    """Put a collection's playlist at this place among the others (smaller comes first)."""
    record = _update(root, collection_id, order=order)
    _mirror_in_sidecar(root, record, "order", order)
    return record


def move_before(root: Path | str, collection_id: str, other: str) -> None:
    """Put a collection just before another, renumbering all orders 10, 20, 30...

    Raises:
        ValueError: when either id is unknown or they are the same.
    """
    if collection_id == other:
        raise ValueError("a collection cannot move before itself")
    records = read_registry(root)
    moving = find_record(records, collection_id)
    find_record(records, other)
    sequence = [r for r in records if r["id"] != collection_id]
    position = next(i for i, r in enumerate(sequence) if r["id"] == other)
    sequence.insert(position, moving)
    for place, record in enumerate(sequence, start=1):
        record["order"] = place * ORDER_STEP
        _mirror_in_sidecar(root, record, "order", record["order"])
    write_registry(root, sequence)


def set_lazy(root: Path | str, collection_id: str, lazy: bool) -> dict:
    """Make the app read a collection's file only when the visitor needs it (or at start)."""
    return _update(root, collection_id, lazy=lazy)


def _mirror_in_sidecar(root: Path | str, record: dict, key: str, value: object) -> None:
    """Keep a local MIDI collection's `collection.toml` in step with a registry change.

    The sidecar is where the student edits the name and the order, so a change made through the
    registry commands must not be undone by the next `collection build`.
    """
    if record["kind"] != "local-midi" or "dir" not in record:
        return
    sidecar = Path(root) / record["dir"] / "collection.toml"
    if not sidecar.exists():
        return
    text = sidecar.read_text(encoding="utf-8")
    head, separator, songs = text.partition("[[song]]")
    line = f"{key} = {json.dumps(value, ensure_ascii=False)}"
    head, count = re.subn(rf"(?m)^{key} = .*$", lambda _: line, head, count=1)
    if count:
        sidecar.write_text(head + separator + songs, encoding="utf-8")


# --- remove ---


def remove_collection(
    root: Path | str,
    collection_id: str,
    force: bool = False,
    delete_files: bool = False,
) -> None:
    """Unregister a collection and delete its catalog file, never the student's MIDI files.

    A built-in collection needs `force`. The committed lead sheets of an open set
    (`data/catalog/abc/<id>/`) are deleted only with `delete_files`; the Examples' lead sheets
    (`data/leadsheets/`) are used by the samples and are never deleted.

    Raises:
        ValueError: when the id is unknown, or a built-in collection is removed without `force`.
    """
    records = read_registry(root)
    record = find_record(records, collection_id)
    if is_builtin(collection_id) and not force:
        raise ValueError(
            f"'{collection_id}' is a built-in collection; use --force to remove it "
            "(or `collection disable` to hide it)"
        )
    write_registry(root, [r for r in records if r["id"] != collection_id])
    _catalog_file(root, record).unlink(missing_ok=True)
    lead_sheets = Path(root) / ABC_DIR / collection_id
    if delete_files and lead_sheets.is_dir():
        shutil.rmtree(lead_sheets)


# --- rebuild ---


def rebuild_collection(
    root: Path | str,
    collection_id: str,
    dataset: Path | str | None = None,
    run: Runner | None = None,
) -> None:
    """Run the commands that regenerate a collection's catalog file.

    A built-in collection runs its `catalog ...` generator, then `catalog popularity`; a local
    MIDI collection runs `collection build` on its folder; a remote one is read again from the
    list of links it was made from. A generator that needs data this machine lacks (the MPB
    study copy, the PDMX or Nottingham downloads) is refused before anything runs.

    Args:
        dataset: the local MPB study copy (a folder with `metadata.csv`), for `mpb` and
            `public-domain`.
        run: runs one `main.py` command and returns its exit code (default: `main.main`).

    Raises:
        ValueError: when the data is missing, or a step fails.
    """
    root = Path(root)
    record = find_record(read_registry(root), collection_id)
    steps = _rebuild_steps(root, record, dataset)
    if run is None:
        run = _run_main
    for step in steps:
        code = run(step)
        if code != 0:
            raise ValueError(f"`{' '.join(step)}` failed with exit code {code}")


def _run_main(argv: list[str]) -> int:
    from main import main  # imported here: main imports this module's command line

    return main(argv)


def _rebuild_steps(root: Path, record: dict, dataset: Path | str | None) -> list[list[str]]:
    collection_id = record["id"]
    if record["kind"] == "local-midi":
        if "dir" not in record:
            raise ValueError(f"'{collection_id}' has no folder recorded; run collection build")
        return [["collection", "build", record["dir"], "--root", str(root)]]
    if record["kind"] == "remote" and "from" in record:
        return [
            [
                "collection",
                "add-remote",
                collection_id,
                "--name",
                record["name"],
                "--from",
                record["from"],
                "--root",
                str(root),
            ]
        ]
    if collection_id not in BUILTIN_REBUILDS:
        raise ValueError(f"'{collection_id}' has no recorded generator: {record['generated']}")
    steps, needs = BUILTIN_REBUILDS[collection_id]
    for need in needs:
        if need == "dataset":
            if dataset is None:
                raise ValueError(
                    f"rebuilding '{collection_id}' needs the local MPB study copy: "
                    "pass --dataset <folder with metadata.csv>"
                )
            if not (Path(dataset) / "metadata.csv").exists():
                raise ValueError(f"{dataset} has no metadata.csv: it is not the MPB study copy")
        elif not (root / need).exists():
            raise ValueError(
                f"rebuilding '{collection_id}' needs {need}: {NEEDS_HELP.get(need, 'create it')}"
            )
    return [[part.replace("{dataset}", str(dataset)) for part in step] for step in steps]


# --- add-remote ---


def slugify(text: str) -> str:
    """Return a lowercase ASCII slug of a title: letters and digits, words joined by dashes.

    >>> slugify("Águas de Março (1972)")
    'aguas-de-marco-1972'
    """
    from catalog.cards import normalized_title

    return "-".join(re.findall(r"[a-z0-9]+", normalized_title(text))) or "song"


def _read_song_list(path: Path) -> list[dict]:
    """Read a CSV (header row) or a JSON list of songs: title, composer, url and optional more."""
    if path.suffix.lower() == ".json":
        stored = json.loads(path.read_text(encoding="utf-8"))
        rows = stored["songs"] if isinstance(stored, dict) else stored
    else:
        with path.open(encoding="utf-8", newline="") as handle:
            rows = list(csv.DictReader(handle))
    return [{str(key).strip().lower(): value for key, value in row.items()} for row in rows]


def add_remote(
    root: Path | str,
    collection_id: str,
    name: str,
    source_list: Path | str,
    license_text: str | None = None,
    credit: str | None = None,
    home: str | None = None,
    order: float | None = None,
    lazy: bool = False,
) -> list[dict]:
    """Make a collection of songs that live on another site, from a list of titles and links.

    Nothing is fetched. Each song opens by download: the visitor's browser saves the MIDI file
    from its site and the visitor drops it on the page. The list is a CSV (with a header row) or
    a JSON list with `title`, `url` and optionally `composer`, `performer`, `popularity`
    (a number) and `license`.

    Args:
        collection_id: the new collection's id (a slug).
        name: its playlist's name.
        source_list: the CSV or JSON file, inside the repository, kept as the way to rebuild it.
        license_text: what the site's terms say; by default the previous catalog's, else
            "unknown: see the source site".
        credit: whom to credit; home: the site's address (default: the first link's site).
        order: place among the playlists (default: keep the current one, else after the rest).
        lazy: read the file only when the visitor needs it.

    Returns:
        The catalog entries written.

    Raises:
        ValueError: when a row has no title or a link that is not http(s), or the id is refused.
    """
    root = Path(root)
    check_new_id(root, collection_id, "remote")
    source_list = Path(source_list)
    rows = _read_song_list(source_list)
    entries, used = [], set()
    for number, row in enumerate(rows, start=2 if source_list.suffix.lower() != ".json" else 1):
        title = (row.get("title") or "").strip()
        url = (row.get("url") or "").strip()
        if not title:
            raise ValueError(f"{source_list.name} row {number}: the title is empty")
        if urlparse(url).scheme not in ("http", "https") or not urlparse(url).netloc:
            raise ValueError(f"{source_list.name} row {number} ({title}): the url must be http(s)")
        song_id, suffix = slugify(title), 2
        while song_id in used:
            song_id = f"{slugify(title)}-{suffix}"
            suffix += 1
        used.add(song_id)
        entry = {
            "id": song_id,
            "source": collection_id,
            "t": title,
            "c": (row.get("composer") or "").strip(),
            "p": (row.get("performer") or "").strip(),
            "license": (row.get("license") or "").strip() or "unknown",
            "seed": sprite_seed(collection_id, song_id),
            "route": {"download": url},
        }
        popularity = str(row.get("popularity") or "").strip()
        if popularity:
            entry["pop"] = int(float(popularity))
        entries.append(entry)

    previous = _read_catalog(root, {"path": f"data/catalog/{collection_id}.json"}) or {}
    first_site = urlparse(entries[0]["route"]["download"]).netloc if entries else ""
    envelope = {
        "source": collection_id,
        "name": name,
        "home": home or previous.get("home") or f"https://{first_site}/",
        "license": license_text or previous.get("license") or "unknown: see the source site",
        "credit": credit or previous.get("credit") or f"Songs listed from {first_site}",
        "note": "Titles, composers and links only; no file is fetched or stored. A visitor "
        "downloads the MIDI file from its site and drops it on the page.",
        "generated": f"uv run src/main.py collection add-remote {collection_id} "
        f'--name "{name}" --from {_relative(root, source_list)}',
    }
    write_catalog_file(root / CATALOG_DIR / f"{collection_id}.json", envelope, entries)
    existing = next((r for r in read_registry(root) if r["id"] == collection_id), None)
    register(
        root,
        {
            "id": collection_id,
            "path": f"data/catalog/{collection_id}.json",
            "name": name,
            "kind": "remote",
            "lazy": lazy if existing is None else existing["lazy"],
            "order": order
            if order is not None
            else (existing["order"] if existing else _next_order(root)),
            "enabled": existing["enabled"] if existing else True,
            "generated": envelope["generated"],
            "from": _relative(root, source_list),
        },
    )
    return entries


def _relative(root: Path, path: Path) -> str:
    """Return `path` relative to the repository root, with forward slashes."""
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def _next_order(root: Path) -> int:
    """Return an order that puts a new collection after the others that are not built in."""
    return max([LOCAL_ORDER - ORDER_STEP, *(r["order"] for r in read_registry(root))]) + ORDER_STEP
