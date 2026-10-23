"""The `collection` command: manage the app's collections from the command line.

    uv run src/main.py collection list
    uv run src/main.py collection init songs/mine --license CC0-1.0 --source https://example.org
    uv run src/main.py collection build songs/mine --license CC0-1.0
    uv run src/main.py collection disable mpb

Every subcommand takes `--root` (the repository, default: the current folder). The commands
that change the registry are in `catalog.registry`; the ones that make a collection from a
folder of MIDI files are in `catalog.own_collection`.
"""

import argparse
from pathlib import Path

from catalog import registry


def add_collection_command(commands: argparse._SubParsersAction) -> argparse.ArgumentParser:
    """Add the `collection` command and its subcommands to `main.py`."""
    collection = commands.add_parser(
        "collection", help="manage the app's collections (playlists of songs)"
    )
    sub = collection.add_subparsers(dest="collection_command", required=True)

    def command(name: str, help_text: str, handler) -> argparse.ArgumentParser:
        parser = sub.add_parser(name, help=help_text)
        parser.add_argument("--root", type=Path, default=Path("."), help="the repository folder")
        parser.set_defaults(handler=handler)
        return parser

    command("list", "table of every collection", run_list)
    show = command("show", "a collection's record, envelope, first songs and counts", run_show)
    show.add_argument("id")
    show.add_argument("--first", type=int, default=5, help="songs to list (default 5)")
    for name, on in (("enable", True), ("disable", False)):
        parser = command(name, f"{name} a collection (a disabled one is not loaded)", run_enable)
        parser.add_argument("id")
        parser.set_defaults(enabled=on)
    rename = command("rename", "change the name of a collection's playlist", run_rename)
    rename.add_argument("id")
    rename.add_argument("name")
    order = command("order", "set a collection's place among the playlists", run_order)
    order.add_argument("id")
    order.add_argument("number", type=float)
    move = command("move", "put a collection just before another", run_move)
    move.add_argument("id")
    move.add_argument("--before", required=True, metavar="OTHER_ID")
    lazy = command(
        "lazy", "read a collection's file only when needed (on) or at start (off)", run_lazy
    )
    lazy.add_argument("id")
    lazy.add_argument("state", choices=("on", "off"))
    rebuild = command(
        "rebuild", "run the command that regenerates a collection's file", run_rebuild
    )
    rebuild.add_argument("id")
    rebuild.add_argument(
        "--dataset", type=Path, help="the local MPB study copy (mpb, public-domain)"
    )
    remove = command("remove", "unregister a collection and delete its catalog file", run_remove)
    remove.add_argument("id")
    remove.add_argument("--force", action="store_true", help="allow removing a built-in collection")
    remove.add_argument(
        "--delete-files",
        action="store_true",
        help="also delete the committed lead sheets of an open set (data/catalog/abc/<id>/)",
    )
    remote = command(
        "add-remote",
        "a collection of songs on another site, from a list of titles and links",
        run_add_remote,
    )
    remote.add_argument("id")
    remote.add_argument("--name", required=True, help="the playlist's name")
    remote.add_argument(
        "--from", dest="source_list", type=Path, required=True, metavar="CSV_OR_JSON"
    )
    remote.add_argument("--license", dest="license_text", help="what the site's terms say")
    remote.add_argument("--credit", help="whom to credit")
    remote.add_argument("--home", help="the site's address")
    remote.add_argument("--order", type=float, help="place among the playlists")
    remote.add_argument("--lazy", action="store_true", help="read the file only when needed")

    from catalog.own_collection import add_own_collection_commands

    add_own_collection_commands(command)
    return collection


def run_list(args: argparse.Namespace) -> None:
    """Print the table of collections."""
    print(registry.list_collections(args.root))


def run_show(args: argparse.Namespace) -> None:
    """Print one collection."""
    print(registry.show_collection(args.root, args.id, args.first))


def run_enable(args: argparse.Namespace) -> None:
    """Enable or disable a collection."""
    registry.set_enabled(args.root, args.id, args.enabled)
    print(f"{args.id}: {'enabled' if args.enabled else 'disabled'}")


def run_rename(args: argparse.Namespace) -> None:
    """Rename a collection's playlist."""
    registry.rename_collection(args.root, args.id, args.name)
    print(f"{args.id}: named {args.name!r}")


def run_order(args: argparse.Namespace) -> None:
    """Set a collection's order."""
    registry.set_order(args.root, args.id, args.number)
    print(f"{args.id}: order {args.number:g}")


def run_move(args: argparse.Namespace) -> None:
    """Move a collection before another."""
    registry.move_before(args.root, args.id, args.before)
    print(registry.list_collections(args.root))


def run_lazy(args: argparse.Namespace) -> None:
    """Switch lazy loading of a collection."""
    registry.set_lazy(args.root, args.id, args.state == "on")
    print(f"{args.id}: lazy {args.state}")


def run_rebuild(args: argparse.Namespace) -> None:
    """Rebuild a collection."""
    registry.rebuild_collection(args.root, args.id, args.dataset)


def run_remove(args: argparse.Namespace) -> None:
    """Remove a collection."""
    registry.remove_collection(args.root, args.id, args.force, args.delete_files)
    print(f"{args.id}: removed (MIDI files and the sidecar are untouched)")


def run_add_remote(args: argparse.Namespace) -> None:
    """Make a collection of download links."""
    entries = registry.add_remote(
        args.root,
        args.id,
        args.name,
        args.source_list,
        args.license_text,
        args.credit,
        args.home,
        args.order,
        args.lazy,
    )
    print(f"{args.id}: {len(entries)} songs, each opened by download from its site")
